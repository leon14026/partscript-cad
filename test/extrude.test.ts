import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { mismatchReason, ModelBuilder } from '../src/engine/build.ts';
import { parseCsg, unsupported } from '../src/engine/csg.ts';
import { meshVolume, parseBinaryStl } from '../src/engine/mesh.ts';
import { evaluateScad, renderMesh, type OpenScadFactory } from '../src/engine/scad.ts';
import { buildSolid } from '../src/engine/solid.ts';
import { facetedText } from '../src/engine/summary.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
let engineRuns = 0;
const openScad: OpenScadFactory = (options) => {
  engineRuns++;
  return instantiate({ ...options, wasmBinary: wasm });
};
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

after(() => kernel.releaseAll());

function near(actual: number, expected: number, relative = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= relative * Math.abs(expected), `Expected ${expected}, received ${actual}`);
}

async function build(source: string, maker = builder) {
  const model = await maker.build({ 'design.scad': source }, 'design.scad');
  return { model, mesh: model.preview.meshes[0] };
}

/** An exact part: its volume, and the STEP text read back through OpenCascade. */
async function exact(source: string, volume: number, relative = 1e-4) {
  const { model, mesh } = await build(source);
  assert.equal(mesh.quality, 'exact', `${source} came out ${mesh.quality}: ${mesh.reason}`);
  near(mesh.volume, volume, relative);
  const step = new TextDecoder().decode(builder.exportStep(model));
  const mark = kernel.checkpoint();
  const shape = kernel.importStep(step);
  near(kernel.getVolume(shape), volume, relative);
  const faces = kernel.subShapeCount(shape, 'face');
  kernel.releaseSince(mark);
  return { mesh, step, faces };
}

const pi = Math.PI;

test('a: extruded squares and Booleans are exact, with flat faces only', async () => {
  const { step, faces } = await exact('linear_extrude(5) difference() { square([40, 30]); translate([5, 5]) square([10, 10]); }', 5 * 1100);
  assert.doesNotMatch(step, /CYLINDRICAL_SURFACE/);
  assert.equal(faces, 10);
});

test('b: a round hole in an extruded plate is a true cylinder in STEP', async () => {
  const { step } = await exact('linear_extrude(5) difference() { square([40, 30]); translate([10, 10]) circle(4); }', 5 * (1200 - 16 * pi));
  assert.match(step, /CYLINDRICAL_SURFACE/);
  assert.ok(step.length < 40_000, `STEP is ${step.length} bytes`);
});

test('c: circle with $fn = 5 is a pentagon prism with its first corner on +X', async () => {
  const r = 45.0845;
  const { mesh } = await exact('linear_extrude(10) circle(r = 45.0845, $fn = 5);', 10 * 2.5 * r * r * Math.sin((2 * pi) / 5));
  assert.ok(Math.abs(mesh.bounds.max[0] - r) < 1e-3);
  assert.ok(Math.abs(mesh.bounds.min[0] + r * Math.cos(pi / 5)) < 1e-3);
});

test('d: the D-shaft is a circle with a flat, and keeps its cylinder', async () => {
  const r = 4;
  const flat = 3.2;
  const segment = r * r * Math.acos(flat / r) - flat * Math.sqrt(r * r - flat * flat);
  const { step } = await exact('linear_extrude(20) intersection() { circle(d = 8); translate([-8, -8]) square([16, 11.2]); }', 20 * (pi * r * r - segment));
  assert.match(step, /CYLINDRICAL_SURFACE/);
});

test('e: offset(delta) of a convex polygon moves each edge, corners stay sharp', async () => {
  const r = 45.0845;
  const apothem = r * Math.cos(pi / 5) - 1.2;
  await exact('linear_extrude(5) offset(delta = -1.2) circle(r = 45.0845, $fn = 5);', 5 * 5 * apothem * apothem * Math.tan(pi / 5));
  const grown = r * Math.cos(pi / 5) + 2;
  await exact('linear_extrude(5) offset(delta = 2) circle(r = 45.0845, $fn = 5);', 5 * 5 * grown * grown * Math.tan(pi / 5));
});

test('f: a rounded rectangle is a prism with four cylinders', async () => {
  const { step } = await exact('linear_extrude(5) offset(r = 3) offset(delta = -3) square([40, 30]);', 5 * (1200 - (4 - pi) * 9));
  assert.match(step, /CYLINDRICAL_SURFACE/);
});

test('g: a slot of two circles has six faces', async () => {
  const { step, faces } = await exact('linear_extrude(5) hull() { circle(d = 10); translate([30, 0]) circle(d = 10); }', 5 * (300 + 25 * pi));
  assert.match(step, /CYLINDRICAL_SURFACE/);
  assert.ok(faces <= 10, `${faces} faces`);
});

test('h: the hull of two unequal circles uses the tangent lines', async () => {
  const [big, small, d] = [11, 7, 40];
  const phi = Math.asin((big - small) / d);
  const tangent = Math.sqrt(d * d - (big - small) ** 2);
  const area = 0.5 * big * big * (pi + 2 * phi) + 0.5 * small * small * (pi - 2 * phi) + (big + small) * tangent;
  await exact('linear_extrude(5) hull() { circle(d = 22); translate([40, 0]) circle(d = 14); }', 5 * area);
});

test('i: offset(r) of a hull widens each circle', async () => {
  await exact('linear_extrude(5) offset(r = 2) hull() { circle(d = 10); translate([30, 0]) circle(d = 10); }', 5 * (30 * 14 + pi * 49));
});

test('j: a concave polygon with a hole, in either order of outlines', async () => {
  // An L of area 48 with a 2 by 2 hole in its long arm, 1 mm thick.
  const l = '[[0, 0], [8, 0], [8, 4], [4, 4], [4, 8], [0, 8]]';
  const hole = '[[1, 1], [3, 1], [3, 3], [1, 3]]';
  for (const paths of ['[[0, 1, 2, 3, 4, 5], [6, 7, 8, 9]]', '[[6, 7, 8, 9], [0, 1, 2, 3, 4, 5]]']) {
    await exact(`linear_extrude(1) polygon(points = concat(${l}, ${hole}), paths = ${paths});`, 44);
  }
});

test('k: a prism from $fn, and scaled boxes and cylinders', async () => {
  await exact('cylinder(h = 5, d = 12, $fn = 6);', 5 * 1.5 * Math.sqrt(3) * 36);
  await exact('scale(2) cube(1);', 8);
  await exact('scale([1, 2, 3]) cube(1);', 6);
  const { step } = await exact('scale(2) cylinder(r = 1, h = 1);', 8 * pi);
  assert.match(step, /CYLINDRICAL_SURFACE/);
  await exact('translate([5, 0, 0]) scale([1, 2, 3]) sphere(1);', (4 / 3) * pi * 6, 2e-3);
  await exact('mirror([1, 0, 0]) scale(3) cube([1, 2, 3]);', 27 * 6);
});

test('2D moves: rotate, mirror, centre and a uniform scale of an outline', async () => {
  const { mesh } = await exact('linear_extrude(2) mirror([1, 0]) translate([5, 0]) polygon([[0, 0], [4, 0], [0, 3]]);', 12);
  assert.deepEqual(mesh.bounds.min.map((v) => Math.round(v * 1e4) / 1e4), [-9, 0, 0]);
  await exact('linear_extrude(3, center = true) rotate(30) square([4, 2], center = true);', 24);
  await exact('linear_extrude(1) scale(2) circle(3);', pi * 36);
});

/** Pieces modelled on the parts of the fan folder: a pentagon drum, a spacer, a roller, a link and a detent wheel. */
const parts = {
  drum: `
    $fa = 4; $fs = 0.5;
    module d_shaft(d, c = 0) intersection() { circle(d = d + c); translate([-d, -d]) square([2 * d, d + d / 2 - 6.4 + c / 2]); }
    module rrect(x0, x1, y0, y1, r) translate([x0, y0]) offset(r = r) offset(delta = -r) square([x1 - x0, y1 - y0]);
    module outline() {
      rotate(90) circle(r = 45.0845, $fn = 5);
      for (i = [0 : 4]) rotate(90 + i * 72) translate([42, -2]) offset(r = 0.8) offset(delta = -0.8) square([8, 4]);
    }
    difference() {
      union() { cylinder(r = 50.8845, h = 4); linear_extrude(60) outline(); }
      translate([0, 0, 4]) linear_extrude(60) difference() {
        offset(delta = -1.2) rotate(90) circle(r = 45.0845, $fn = 5);
        circle(d = 14);
        for (i = [0 : 4]) rotate(90 + 36 + i * 72) translate([0, -1.5]) square([45, 3]);
      }
      translate([0, 0, -1]) linear_extrude(70) d_shaft(8, 0.2);
      rotate(90) translate([44, 0, -0.01]) linear_extrude(0.6) polygon([[-3, -3], [3, 0], [-3, 3]]);
    }`,
  spacer: 'linear_extrude(12) difference() { circle(d = 16); intersection() { circle(d = 8.2); translate([-8, -8]) square([16, 11.4]); } }',
  roller: `linear_extrude(110) difference() {
      union() {
        difference() { circle(d = 32); circle(d = 28); }
        circle(d = 14);
        for (a = [0, 120, 240]) rotate(a) translate([0, -1]) square([15, 2]);
      }
      circle(d = 8.6);
    }`,
  link: `linear_extrude(4) difference() {
      union() {
        hull() { circle(d = 8); translate([60, 0]) circle(d = 8); }
        circle(d = 12);
        translate([60, 0]) circle(d = 12);
      }
      circle(d = 3.4);
      translate([60, 0]) circle(d = 3.4);
    }`,
  detent: `linear_extrude(3) difference() {
      circle(r = 30);
      intersection() { circle(d = 8.2); translate([-8, -8]) square([16, 11.4]); }
      rotate(90) translate([30, 0]) rotate(45) square(2.8284, center = true);
    }`,
};

test('l: parts modelled on the fan folder are exact and match OpenSCAD\'s fine mesh', async () => {
  for (const [name, source] of Object.entries(parts)) {
    const files = { 'design.scad': source };
    const { model, mesh } = await build(source);
    assert.equal(mesh.quality, 'exact', `${name} came out ${mesh.quality}: ${mesh.reason}`);
    // An independent check: OpenSCAD's own fine mesh of the same shapes.
    const { csg } = await evaluateScad(files, 'design.scad', openScad);
    const fine = csg.replace(/\$fn = 0, \$fa = [^,)]+, \$fs = [^,)]+/g, '$fn = 0, $fa = 1, $fs = 0.05');
    near(mesh.volume, meshVolume(parseBinaryStl(await renderMesh(fine, openScad))), 3e-3);
    assert.ok(builder.exportStep(model).length > 1000);
  }
});

test('an exported drum body keeps its true cylinders and is far smaller than the faceted STEP', async () => {
  const { model, mesh } = await build(parts.drum);
  assert.equal(mesh.quality, 'exact');
  const exactStep = builder.exportStep(model);
  assert.match(new TextDecoder().decode(exactStep), /CYLINDRICAL_SURFACE/);
  // The same shapes forced through the faceted path, as the earlier phases built them.
  const forced = new ModelBuilder(kernel, openScad, undefined, () => { throw new Error('forced'); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const faceted = await build(parts.drum, forced);
    assert.equal(faceted.mesh.quality, 'faceted');
    const facetedStep = forced.exportStep(faceted.model);
    assert.ok(exactStep.length * 3 < facetedStep.length, `exact ${exactStep.length} bytes, faceted ${facetedStep.length} bytes`);
  } finally {
    console.warn = warn;
  }
});

test('shapes the exact builder cannot extrude stay faceted and say why', async () => {
  const cases: [string, string][] = [
    ['linear_extrude(5, twist = 30) square(4);', 'linear_extrude with twist'],
    ['linear_extrude(5, scale = 0.5) square(4);', 'linear_extrude with scale'],
    ['linear_extrude(5) offset(r = 1) difference() { square(10); translate([2, 2]) square(3); }', 'offset of a shape that is not convex'],
    ['linear_extrude(5) offset(delta = 1, chamfer = true) square(10);', 'offset with chamfer'],
    ['linear_extrude(5) hull() { square(4); translate([6, 0]) polygon([[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]]); }', 'hull of a shape that is not convex'],
    ['linear_extrude(5) polygon([[0, 0], [4, 4], [4, 0], [0, 4]]);', 'polygon that crosses itself'],
    ['linear_extrude(5) scale([1, 2]) circle(3);', 'scale'],
    ['linear_extrude(5) minkowski() { square(4); circle(1); }', 'minkowski'],
    ['rotate_extrude() translate([4, 0]) square(2);', 'rotate_extrude'],
    ['cylinder(h = 5, r1 = 3, r2 = 2, $fn = 8);', 'cylinder with $fn'],
    ['sphere(3, $fn = 12);', 'sphere with $fn'],
    ['multmatrix([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) cube(4);', 'multmatrix'],
    ['linear_extrude(2) for (i = [0 : 149]) translate([i * 3, 0]) circle(1);', 'linear_extrude with more than 100 shapes'],
  ];
  for (const [source, reason] of cases) {
    const { mesh } = await build(source);
    assert.equal(mesh.quality, 'faceted', source);
    assert.equal(mesh.reason, reason, source);
    assert.ok(mesh.volume > 0);
  }
});

test('a plain extrusion is no longer reported as faceted', async () => {
  const { model } = await build('linear_extrude(5) square([4, 3]);');
  assert.equal(facetedText(model.preview), '');
});

test('a part that uses only boxes and cylinders skips the check against OpenSCAD', async () => {
  engineRuns = 0;
  await build('cube(4); translate([10, 0, 0]) cylinder(h = 3, r = 2);');
  assert.equal(engineRuns, 1);
  engineRuns = 0;
  await build('linear_extrude(5) square(4);');
  assert.equal(engineRuns, 2);
});

test('a very fine mesh is skipped: the check uses the part\'s own mesh and looser limits', async () => {
  // Four spheres at $fa = 2 are 130 thousand triangles each at the check's own fineness, so the check meshes the part as written.
  const source = '$fa = 2; $fs = 0.1; linear_extrude(2) square(10); for (i = [1 : 4]) translate([i * 20, 0, 0]) sphere(5);';
  engineRuns = 0;
  const { mesh } = await build(source);
  assert.equal(mesh.quality, 'exact', String(mesh.reason));
  assert.equal(engineRuns, 3);
});

test('a wrong exact build falls back to the faceted mesh and says so', async () => {
  const wrong = new ModelBuilder(kernel, openScad, undefined, (k) => buildSolid(k, 'cube(size = [1, 1, 1], center = false);'));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    const { model, mesh } = await build('linear_extrude(5) square([40, 30]);', wrong);
    assert.equal(mesh.quality, 'faceted');
    assert.equal(mesh.reason, mismatchReason);
    near(mesh.volume, 6000);
    assert.match(facetedText(model.preview), /did not match/);
    assert.match(warnings.join('\n'), /The exact build has volume [\d.]+ and the OpenSCAD mesh 6000/);
    // The faceted part still exports.
    assert.ok(wrong.exportStep(model).length > 500);
  } finally {
    console.warn = warn;
  }
});

test('an exact build that throws falls back too, but a plain solid still reports its error', async () => {
  const broken = new ModelBuilder(kernel, openScad, undefined, () => { throw new Error('boom'); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { mesh } = await build('linear_extrude(5) square([40, 30]);', broken);
    assert.equal(mesh.quality, 'faceted');
    assert.equal(mesh.reason, mismatchReason);
    await assert.rejects(build('cube(4);', broken), /boom/);
  } finally {
    console.warn = warn;
  }
});

test('a shape that unsupported() accepts always builds, so a part never errors where it should have been meshed', async () => {
  const sources = [...Object.values(parts), 'linear_extrude(height = 5) { circle(r = 4); translate([9, 0]) square(3); }', 'linear_extrude(3, center = true) offset(r = 2) square(6);'];
  for (const source of sources) {
    const { csg } = await evaluateScad({ 'design.scad': source }, 'design.scad', openScad);
    const nodes = parseCsg(csg);
    assert.equal(unsupported(nodes), undefined, source);
    const mark = kernel.checkpoint();
    assert.ok(buildSolid(kernel, nodes).volume > 0);
    kernel.releaseSince(mark);
  }
});

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { ModelBuilder } from '../src/engine/build.ts';
import { renderMesh, type OpenScadFactory } from '../src/engine/scad.ts';
import { meshVolume, parseBinaryStl } from '../src/engine/mesh.ts';
import { facetedText } from '../src/engine/summary.ts';
import { exampleProjects } from '../src/examples.ts';
import { loadLibrary } from './libraries.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
let engineRuns = 0;
const openScad: OpenScadFactory = (options) => {
  engineRuns++;
  return instantiate({ ...options, wasmBinary: wasm });
};
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad, loadLibrary);
const output = new URL('../.test-output/', import.meta.url);
await mkdir(output, { recursive: true });

after(() => kernel.releaseAll());

function near(actual: number, expected: number, relative = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= relative * Math.abs(expected), `Expected ${expected}, received ${actual}`);
}

/** Build one file, export STEP, read the STEP back, and compare its volume with the preview's. */
async function build(source: string, name: string, bodies = 1) {
  const model = await builder.build({ 'design.scad': source }, 'design.scad');
  const [mesh] = model.preview.meshes;
  const bytes = builder.exportStep(model);
  await writeFile(new URL(`${name}.step`, output), bytes);
  const step = new TextDecoder().decode(bytes);
  assert.match(step, /MANIFOLD_SOLID_BREP/);
  const mark = kernel.checkpoint();
  const shape = kernel.importStep(step);
  assert.equal(kernel.subShapeCount(shape, 'solid'), bodies);
  near(kernel.getVolume(shape), mesh.volume, 1e-3);
  kernel.releaseSince(mark);
  return { mesh, step, model };
}

const polygon = (n: number, r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);

test('a tapered extrusion is faceted with the volume of a frustum', async () => {
  // The top is the 4 x 3 base scaled by 0.5 about the origin: h/3 (A1 + A2 + sqrt(A1 A2)) = 5/3 (12 + 3 + 6).
  const { mesh } = await build('linear_extrude(height = 5, scale = 0.5) square([4, 3]);', 'faceted_extrude');
  assert.equal(mesh.quality, 'faceted');
  assert.equal(mesh.reason, 'linear_extrude with scale');
  near(mesh.volume, 35);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [4, 3, 5] });
  assert.ok(mesh.edgeSegments.length / 6 >= 12);
});

test('an extruded pentagon with a 24-sided hole is exact, with the polygon areas times the height', async () => {
  const source = 'linear_extrude(4) difference() { circle(r = 10, $fn = 5); circle(d = 3, $fn = 24); }';
  const { mesh } = await build(source, 'exact_ring');
  assert.equal(mesh.quality, 'exact');
  near(mesh.volume, 4 * (polygon(5, 10) - polygon(24, 1.5)));
});

test('hull, rotate_extrude and polyhedron build with the volumes worked out by hand', async () => {
  const hull = await build('hull() { cube(2); translate([4, 0, 0]) cube(2); }', 'faceted_hull');
  assert.equal(hull.mesh.reason, 'hull');
  near(hull.mesh.volume, 24);

  // A 64-sided revolve of a 1 x 2 section at radius 5 to 6. The facets shave 0.16% off the ideal 2π × 5.5 × 2.
  const ring = await build('rotate_extrude($fn = 64) translate([5, 0]) square([1, 2]);', 'faceted_revolve');
  assert.equal(ring.mesh.reason, 'rotate_extrude');
  near(ring.mesh.volume, 2 * Math.PI * 5.5 * 2, 0.003);

  const tetra = await build('polyhedron(points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]);', 'faceted_tetrahedron');
  assert.equal(tetra.mesh.reason, 'polyhedron');
  near(tetra.mesh.volume, 1 / 6);
});

test('a sheared box and a cone with $fn are faceted, with the reason named', async () => {
  // A shear keeps the volume of the cube: 4 x 4 x 4.
  const sheared = await build('multmatrix([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) cube(4);', 'faceted_shear');
  assert.equal(sheared.mesh.quality, 'faceted');
  assert.equal(sheared.mesh.reason, 'multmatrix');
  near(sheared.mesh.volume, 64);

  // An octagonal frustum: area 2 sqrt(2) r^2 at each end, 5/3 (A1 + A2 + sqrt(A1 A2)).
  const [a1, a2] = [3, 2].map((r) => 2 * Math.SQRT2 * r * r);
  const cone = await build('cylinder(h = 5, r1 = 3, r2 = 2, $fn = 8);', 'faceted_cone');
  assert.equal(cone.mesh.reason, 'cylinder with $fn');
  near(cone.mesh.volume, (5 / 3) * (a1 + a2 + Math.sqrt(a1 * a2)));
  assert.ok(!cone.step.includes('CYLINDRICAL_SURFACE'), 'eight flats, no true cylinder');
});

test('smooth shapes stay exact at any $fa and $fs, and several bodies in one part are kept', async () => {
  const smooth = await build('$fa = 4; $fs = 0.5; difference() { cube([20, 20, 6]); translate([10, 10, -1]) cylinder(h = 8, d = 8); }', 'exact_smooth');
  assert.equal(smooth.mesh.quality, 'exact');
  near(smooth.mesh.volume, 20 * 20 * 6 - Math.PI * 16 * 6, 1e-6);
  assert.ok(smooth.step.includes('CYLINDRICAL_SURFACE'));

  const two = await build('cube(2); translate([5, 0, 0]) cube(2);', 'exact_two_bodies', 2);
  assert.equal(two.mesh.quality, 'exact');
  near(two.mesh.volume, 16, 1e-6);
});

test('separate bodies in a faceted part export as separate solids', async () => {
  // Two hulls apart: a 6 x 2 x 2 box (24) and a 1 x 4 x 1 box (4). sewAndSolidify alone returns nothing for this.
  const source = 'hull() { cube(2); translate([4, 0, 0]) cube(2); } translate([20, 0, 0]) hull() { cube(1); translate([0, 3, 0]) cube(1); }';
  const { mesh } = await build(source, 'faceted_two_bodies', 2);
  assert.equal(mesh.quality, 'faceted');
  near(mesh.volume, 28);
});

test('a % background shape does not change the solid', async () => {
  const { mesh } = await build('cube(2); %translate([1, 0, 0]) cube(9);', 'exact_background');
  assert.equal(mesh.quality, 'exact');
  near(mesh.volume, 8, 1e-6);
});

test('a file that draws only 2D shapes is told to extrude, and an empty result is reported', async () => {
  await assert.rejects(builder.build({ 'design.scad': 'square(3);' }, 'design.scad'), { message: /linear_extrude/, file: 'design.scad' });
  await assert.rejects(builder.build({ 'design.scad': 'linear_extrude(2) difference() { square(3); translate([-1, -1]) square(5); }' }, 'design.scad'), /no solid volume/);
});

test('an assembly of one exact and one faceted part exports both', async () => {
  const files = {
    'block.scad': 'cube([10, 10, 10]);',
    'bar.scad': 'hull() { cube(2); translate([4, 0, 0]) cube(2); }',
    'main.scad': 'part("block", "block.scad"); part("bar", "bar.scad"); joint("seat", parent = "block", child = "bar", at = [2, 5, 10]);',
  };
  const model = await builder.build(files, 'main.scad');
  assert.deepEqual(model.preview.meshes.map((mesh) => mesh.quality), ['exact', 'faceted']);
  assert.equal(facetedText(model.preview), '1 part is faceted (bar.scad uses hull).');
  const step = new TextDecoder().decode(builder.exportStep(model));
  assert.equal(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)?.length, 2);
  const mark = kernel.checkpoint();
  const shape = kernel.importStep(step);
  assert.equal(kernel.subShapeCount(shape, 'solid'), 2);
  near(kernel.getVolume(shape), 1000 + 24, 1e-3);
  kernel.releaseSince(mark);
});

test('the summary lists at most three files and counts the rest', async () => {
  const part = (file: string) => `part("${file.replace('.scad', '')}", "${file}");`;
  const files: Record<string, string> = {
    'a.scad': 'hull() { cube(1); translate([2, 0, 0]) cube(1); }',
    'b.scad': 'multmatrix([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) cube(1);',
    'c.scad': 'linear_extrude(1, twist = 10) square(2);',
    'd.scad': 'sphere(2, $fn = 8);',
    'main.scad': ['a.scad', 'b.scad', 'c.scad', 'd.scad'].map(part).join('\n'),
  };
  const model = await builder.build(files, 'main.scad');
  assert.equal(facetedText(model.preview),
    '4 parts are faceted (a.scad uses hull, b.scad uses multmatrix, c.scad uses linear_extrude with twist, and 1 more).');
  const alone = await builder.build(files, 'a.scad');
  assert.equal(facetedText(alone.preview), 'This solid is faceted because it uses hull, so STEP has flat faces.');
});

test('every example still builds with every part exact', async () => {
  for (const example of exampleProjects) {
    const model = await builder.build(example.files, example.open);
    if (example.name === 'Label fan folder') {
      // The machine's rocker is a hull() in the owner's design, so it is the one faceted part, and the page says why.
      const faceted = model.preview.assembly.parts.filter((_, index) => model.preview.meshes[model.preview.partMesh[index]].quality !== 'exact');
      assert.deepEqual(faceted.map((part) => part.name), ['rocker']);
      assert.equal(facetedText(model.preview), '1 part is faceted (rocker uses hull).');
      continue;
    }
    assert.ok(model.preview.meshes.every((mesh) => mesh.quality === 'exact'), `${example.name} should be exact`);
    assert.equal(facetedText(model.preview), '');
  }
});

test('a faceted part is meshed once, then reused from the cache', async () => {
  const source = { 'design.scad': 'hull() { cube(3); translate([0, 0, 5]) sphere(2); }' };
  const first = await builder.build(source, 'design.scad');
  assert.equal(first.preview.rebuilt, 1);
  const runs = engineRuns;
  const again = await builder.build(source, 'design.scad');
  assert.equal(again.preview.rebuilt, 0);
  assert.equal(engineRuns - runs, 1, 'only the evaluation of the file runs, not the mesh');
});

test('a dump nested hundreds of groups deep still meshes, as BOSL2 parts are dumped', async () => {
  // BOSL2 wraps each part in many groups. OpenSCAD takes a level of stack for each, and a browser worker has about 1 MB.
  const depth = 600;
  const dump = `${'group() {\n'.repeat(depth)}cube(size = [2, 3, 4], center = false);\n${'}\n'.repeat(depth)}`;
  const stl = await renderMesh(dump, openScad);
  near(meshVolume(parseBinaryStl(stl)), 24);
});

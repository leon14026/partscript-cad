import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { ModelBuilder } from '../src/engine/build.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
import { facetedText } from '../src/engine/summary.ts';
import { exampleProjects } from '../src/examples.ts';

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

const hexagon = (r: number) => 3 * r * r * Math.sin(Math.PI / 3);
const polygon = (n: number, r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);

test('an extruded square is faceted with volume 60', async () => {
  const { mesh } = await build('linear_extrude(5) square([4, 3]);', 'faceted_extrude');
  assert.equal(mesh.quality, 'faceted');
  assert.equal(mesh.reason, 'linear_extrude');
  near(mesh.volume, 60);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [4, 3, 5] });
  assert.ok(mesh.edgeSegments.length / 6 >= 12);
});

test('an extruded pentagon with a 24-sided hole has the polygon areas times the height', async () => {
  const source = 'linear_extrude(4) difference() { circle(r = 10, $fn = 5); circle(d = 3, $fn = 24); }';
  const { mesh } = await build(source, 'faceted_ring');
  assert.equal(mesh.quality, 'faceted');
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

test('scale and a $fn cylinder are faceted, with the reason named', async () => {
  const scaled = await build('scale([1, 2, 3]) cube(1);', 'faceted_scale');
  assert.equal(scaled.mesh.quality, 'faceted');
  assert.equal(scaled.mesh.reason, 'scale');
  near(scaled.mesh.volume, 6);

  const nut = await build('cylinder(h = 5, d = 12, $fn = 6);', 'faceted_hexagon');
  assert.equal(nut.mesh.reason, 'cylinder with $fn');
  near(nut.mesh.volume, 5 * hexagon(6));
  assert.ok(!nut.step.includes('CYLINDRICAL_SURFACE'), 'six flats, no true cylinder');
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
    'nut.scad': 'cylinder(h = 5, d = 12, $fn = 6);',
    'main.scad': 'part("block", "block.scad"); part("nut", "nut.scad"); joint("seat", parent = "block", child = "nut", at = [5, 5, 10]);',
  };
  const model = await builder.build(files, 'main.scad');
  assert.deepEqual(model.preview.meshes.map((mesh) => mesh.quality), ['exact', 'faceted']);
  assert.equal(facetedText(model.preview), '1 part is faceted (nut.scad uses cylinder with $fn).');
  const step = new TextDecoder().decode(builder.exportStep(model));
  assert.equal(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)?.length, 2);
  const mark = kernel.checkpoint();
  const shape = kernel.importStep(step);
  assert.equal(kernel.subShapeCount(shape, 'solid'), 2);
  near(kernel.getVolume(shape), 1000 + 5 * hexagon(6), 1e-3);
  kernel.releaseSince(mark);
});

test('the summary lists at most three files and counts the rest', async () => {
  const part = (file: string) => `part("${file.replace('.scad', '')}", "${file}");`;
  const files: Record<string, string> = {
    'a.scad': 'hull() { cube(1); translate([2, 0, 0]) cube(1); }',
    'b.scad': 'scale([2, 1, 1]) cube(1);',
    'c.scad': 'linear_extrude(1) square(2);',
    'd.scad': 'cylinder(h = 1, d = 3, $fn = 5);',
    'main.scad': ['a.scad', 'b.scad', 'c.scad', 'd.scad'].map(part).join('\n'),
  };
  const model = await builder.build(files, 'main.scad');
  assert.equal(facetedText(model.preview),
    '4 parts are faceted (a.scad uses hull, b.scad uses scale, c.scad uses linear_extrude, and 1 more).');
  const alone = await builder.build(files, 'a.scad');
  assert.equal(facetedText(alone.preview), 'This solid is faceted because it uses hull, so STEP has flat faces.');
});

test('every example still builds with every part exact', async () => {
  for (const example of exampleProjects) {
    const model = await builder.build(example.files, example.open);
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

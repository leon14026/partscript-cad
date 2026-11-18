import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { ModelBuilder } from '../src/engine/build.ts';
import { flatRounds, parseCsg } from '../src/engine/csg.ts';
import type { ProjectFiles } from '../src/engine/protocol.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
import { flatRoundNotes, fnLines } from '../src/engine/summary.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

after(() => kernel.releaseAll());

/** Build a project and give the model and the notes the page would show. */
async function notes(files: ProjectFiles | string, entry = 'design.scad') {
  const project = typeof files === 'string' ? { [entry]: files } : files;
  const { preview } = await builder.build(project, entry);
  return { preview, ...flatRoundNotes(preview, project, entry) };
}

const regularArea = (sides: number, radius: number) => 0.5 * sides * radius ** 2 * Math.sin((2 * Math.PI) / sides);

test('a cylinder with $fn is a polygon: the build counts its sides, and the volume is the polygon\'s', async () => {
  const { preview } = await notes('cylinder(h = 5, d = 12, $fn = 48);');
  const [mesh] = preview.meshes;
  assert.equal(mesh.quality, 'exact');
  assert.deepEqual(mesh.flatRounds, [48]);
  // Prism volume = height x area of a regular 48-gon with corners on a circle of radius 6.
  const expected = 5 * regularArea(48, 6);
  assert.ok(Math.abs(mesh.volume - expected) <= 1e-4 * expected, `Expected ${expected}, received ${mesh.volume}`);
});

test('a cylinder or circle without $fn is a true round shape and is not reported', async () => {
  for (const source of [
    'cylinder(h = 5, d = 12);',
    '$fa = 4; $fs = 0.5; cylinder(h = 5, d = 12);',
    'linear_extrude(4) difference() { square(30); circle(d = 5); }',
  ]) {
    const { preview, errors, logs } = await notes(source);
    assert.equal(preview.meshes[0].flatRounds, undefined, source);
    assert.deepEqual([errors, logs], [[], []], source);
  }
});

test('circles in an extrusion count, and so does every cylinder', async () => {
  const circle = await notes('linear_extrude(4) circle(r = 10, $fn = 24);');
  assert.deepEqual(circle.preview.meshes[0].flatRounds, [24]);
  const hole = await notes('linear_extrude(4) difference() { square(30); translate([15, 15]) circle(d = 5, $fn = 32); }');
  assert.deepEqual(hole.preview.meshes[0].flatRounds, [32]);
  const plate = await notes('difference() { cube([30, 30, 5]); translate([10, 10, -1]) cylinder(h = 7, d = 4, $fn = 48); translate([20, 20, -1]) cylinder(h = 7, d = 4, $fn = 6); }');
  assert.deepEqual(plate.preview.meshes[0].flatRounds, [48, 6]);
});

test('a part that is faceted for another reason has nothing to report', async () => {
  const { preview, errors, logs } = await notes('hull() { cube(10); translate([0, 0, 14]) sphere(5, $fn = 12); }');
  assert.equal(preview.meshes[0].quality, 'faceted');
  assert.equal(preview.meshes[0].flatRounds, undefined);
  assert.deepEqual([errors, logs], [[], []]);
});

test('flatRounds counts what the exact builder makes as a prism, and nothing else', () => {
  const sides = (source: string) => flatRounds(parseCsg(source));
  assert.deepEqual(sides('cylinder($fn = 48, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 6, center = false);'), [48]);
  // A cone with $fn is not a prism, a fraction of sides is dropped, and fewer than 3 sides still make a triangle.
  assert.deepEqual(sides('cylinder($fn = 48, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 3, center = false);'), []);
  assert.deepEqual(sides('cylinder($fn = 12.9, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 6, center = false);'), [12]);
  assert.deepEqual(sides('cylinder($fn = 1, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 6, center = false);'), [3]);
  assert.deepEqual(sides('cylinder($fn = 0, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 6, center = false);'), []);
});

test('an error names the file and the line where $fn is set, and says what to delete', async () => {
  const { errors, logs } = await notes('// a plate\n$fn = 48;\ndifference() {\n  cube([30, 30, 5]);\n  translate([10, 10, -1]) cylinder(h = 7, d = 4);\n}\n');
  assert.deepEqual(errors, ['design.scad: 1 cylinder or circle is a 48-sided polygon in STEP, not true round (set on line 2). Delete $fn for true cylinders and round holes.']);
  assert.deepEqual(logs, []);
});

test('15 sides or fewer are only logged, and 16 or more are errors', async () => {
  const hex = await notes('cylinder(h = 5, d = 12, $fn = 6);');
  assert.deepEqual(hex.errors, []);
  assert.deepEqual(hex.logs, ['design.scad: 1 cylinder or circle is a 6-sided polygon in STEP, not true round (set on line 1).']);
  const edge = (fn: number) => notes(`cylinder(h = 5, d = 12, $fn = ${fn});`);
  assert.equal((await edge(15)).errors.length, 0);
  assert.equal((await edge(15)).logs.length, 1);
  assert.equal((await edge(16)).errors.length, 1);
  assert.equal((await edge(16)).logs.length, 0);
});

test('one part with both kinds gives an error for the many-sided ones and a log for the few-sided', async () => {
  const { errors, logs } = await notes('difference() {\n  cube([30, 30, 5]);\n  translate([10, 10, -1]) cylinder(h = 7, d = 4, $fn = 48);\n  translate([20, 20, -1]) cylinder(h = 7, d = 4, $fn = 6);\n  translate([20, 10, -1]) cylinder(h = 7, d = 4, $fn = 24);\n}\n');
  // Only the lines that give 24 or 48 are named in the error, and only the line that gives 6 in the log.
  assert.deepEqual(errors, ['design.scad: 2 cylinders or circles are 24- and 48-sided polygons in STEP, not true round (set on lines 3 and 5). Delete $fn for true cylinders and round holes.']);
  assert.deepEqual(logs, ['design.scad: 1 cylinder or circle is a 6-sided polygon in STEP, not true round (set on line 4).']);
});

test('a part file and an inline part are named as the user wrote them', async () => {
  const files = { 'main.scad': 'part("pin") { cylinder(h = 5, d = 3, $fn = 32); }\npart("hub", "hub.scad");\n', 'hub.scad': 'cube(5);\ncylinder(h = 5, d = 12, $fn = 64);\n' };
  const { errors } = await notes(files, 'main.scad');
  assert.deepEqual(errors, [
    'main.scad, part("pin"): 1 cylinder or circle is a 32-sided polygon in STEP, not true round (set on line 1). Delete $fn for true cylinders and round holes.',
    'hub.scad: 1 cylinder or circle is a 64-sided polygon in STEP, not true round (set on line 2). Delete $fn for true cylinders and round holes.',
  ]);
});

test('when $fn is not a plain number the line is still named, and when it is not in the file the text says so', async () => {
  const source = 'n = 24 * 2;\ncylinder(h = 5, d = 12, $fn = n);\n';
  const { preview, errors } = await notes(source);
  assert.ok(errors[0].endsWith('(set on line 2). Delete $fn for true cylinders and round holes.'), errors[0]);
  const elsewhere = flatRoundNotes(preview, { 'design.scad': 'cube(1);\n' }, 'design.scad');
  assert.ok(elsewhere.errors[0].includes('(set in an included file or a library)'), elsewhere.errors[0]);
});

test('fnLines skips comments and strings, and counts lines from 1', () => {
  const source = '// $fn = 12\ncube(1); /* $fn = 24\n$fn = 36 */\necho("$fn = 48");\n$fn = 60; // $fn = 72\nx = 1;\ncylinder(r = 1, h = 1, $fn=6);';
  assert.deepEqual(fnLines(source), [{ line: 5, value: 60 }, { line: 7, value: 6 }]);
  assert.deepEqual(fnLines('$fn = n;'), [{ line: 1, value: undefined }]);
  assert.deepEqual(fnLines(''), []);
});

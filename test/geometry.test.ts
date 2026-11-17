import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { checkProject, evaluateScad, type OpenScadFactory } from '../src/engine/scad.ts';
import { buildSolid, previewSolid, writeStep } from '../src/engine/solid.ts';
import { examples } from '../src/examples.ts';
import type { Vec3 } from '../src/engine/protocol.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const output = new URL('../.test-output/', import.meta.url);
await mkdir(output, { recursive: true });

after(() => kernel.releaseAll());

function near(actual: number, expected: number, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

async function build(source: string) {
  kernel.releaseAll();
  const files = { 'design.scad': source };
  checkProject(files, 'design.scad');
  const { csg } = await evaluateScad(files, 'design.scad', openScad);
  const { shape, volume } = buildSolid(kernel, csg);
  return { shape, volume, ...previewSolid(kernel, shape) };
}

async function verify(source: string, name: string, sizes: Vec3, volume: number, surfaces: string[]) {
  const model = await build(source);
  assert.ok(model.indices.length > 30);
  assert.ok(model.edgeSegments.length > 0);
  sizes.forEach((size, i) => near(model.bounds.max[i] - model.bounds.min[i], size));
  near(model.volume, volume);
  const bytes = writeStep(kernel, model.shape);
  const step = new TextDecoder().decode(bytes);
  assert.match(step, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  for (const surface of surfaces) assert.ok(step.includes(surface), `Expected ${surface} in STEP`);
  await writeFile(new URL(`${name}.step`, output), bytes);
}

test('parameter edits regenerate the real mounting plate and its four cylindrical holes', async () => {
  const { source } = examples[0];
  await verify(source, 'mounting_plate', [80, 40, 6], 80 * 40 * 6 - 4 * Math.PI * 2.5 ** 2 * 6, ['CYLINDRICAL_SURFACE']);
  const change = source.replace('width = 80;', 'width = 100;').replace('hole_diameter = 5;', 'hole_diameter = 8;');
  await verify(change, 'mounting_plate_revised', [100, 40, 6], 100 * 40 * 6 - 4 * Math.PI * 4 ** 2 * 6, ['CYLINDRICAL_SURFACE']);
});

test('open enclosure retains its floor and wall dimensions', async () => {
  await verify(examples[1].source, 'open_enclosure', [64, 42, 26], 64 * 42 * 26 - 58 * 36 * 22, ['PLANE']);
});

test('tapered spacer and ball seat retain their analytic surfaces', async () => {
  await verify(examples[2].source, 'tapered_spacer', [28, 28, 12],
    Math.PI * 12 * (14 ** 2 + 14 * 10 + 10 ** 2) / 3 - Math.PI * 4 ** 2 * 12,
    ['CONICAL_SURFACE', 'CYLINDRICAL_SURFACE']);
  await verify(examples[3].source, 'ball_seat', [35, 35, 12],
    35 ** 2 * 12 - Math.PI * 8 ** 2 * (11 - 8 / 3), ['SPHERICAL_SURFACE']);
});

test('rotation, mirror, union and intersection preserve valid geometry', async () => {
  const shape = await build(`
    function reach(length) = length / 2;
    mirror([1, 2, 0]) rotate([5, 12, 20])
        intersection() {
            union() {
                cube([20, 10, 6]);
                translate([19, 0, 0]) cube([4, 10, 6]);
            }
            cube([reach(26), 12, 8]);
        }
  `);
  near(shape.volume, 780);
  assert.equal(kernel.isValid(shape.shape), true);
  await writeFile(new URL('transformed_intersection.step', output), writeStep(kernel, shape.shape));
});

test('failed builds reject empty results, bad syntax, unknown modules and missing libraries', async () => {
  await assert.rejects(build('difference() { group() {} cube(4); }'), /no solid volume/);
  await assert.rejects(build('intersection() { difference() { cube(1); cube(2); } cube(4); }'), /no solid volume/);
  await assert.rejects(build('include <MCAD/boxes.scad>\ncube(4);'), /External libraries/);
  await assert.rejects(build('size = ;\ncube(size);'), { line: 1 });
  await assert.rejects(build('cube(4);\nmisspelled_module();'), { line: 2 });
});

test('an unknown name says what to change instead of repeating OpenSCAD', async () => {
  await assert.rejects(build('size = 4;\ncube(handle_gap);'), (error: Error & { line?: number }) => {
    assert.equal(error.line, 2);
    assert.match(error.message, /^The variable handle_gap is not defined\. Fix its spelling, or give it a value above this line/);
    assert.match(error.message, /right version/);
    assert.doesNotMatch(error.message, /Ignoring/);
    return true;
  });
  await assert.rejects(build('cube(4);\nmisspelled_module();'), (error: Error) => {
    assert.match(error.message, /^There is no module named misspelled_module\. Fix its spelling, or include the file that defines it/);
    return true;
  });
  await assert.rejects(build('cube(nofun(2));'), /There is no function named nofun\. Fix its spelling/);
});

test('facet settings no longer stop a part, and separate bodies stay in one part', async () => {
  const round = await build('$fa = 4; $fs = 0.5; cylinder(h = 5, d = 12);');
  near(round.volume, Math.PI * 36 * 5);
  const two = await build('cube(2); translate([5, 0, 0]) cube(2);');
  near(two.volume, 16);
  assert.equal(kernel.subShapeCount(two.shape, 'solid'), 2);
});

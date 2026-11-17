import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { swivelArm } from '../src/assemblyExample.ts';
import { axisRotation, defaultPose, multiply, placement, poseBounds, solvePose } from '../src/engine/assembly.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);
const output = new URL('../.test-output/', import.meta.url);
await mkdir(output, { recursive: true });

function near(actual: number, expected: number, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

const pair = (assembly: string) => ({
  'a.scad': 'cube([10, 10, 10]);',
  'b.scad': 'cube([4, 4, 20]);',
  'main.scad': assembly,
});

test('joint mathematics follows the OpenSCAD conventions', () => {
  // rotate([90, 0, 0]) turns +Y onto +Z.
  const turned = placement([0, 0, 0], [90, 0, 0]);
  near(turned[1 * 4 + 1], 0);
  near(turned[2 * 4 + 1], 1);
  // rotate([0, 0, 90]) after rotate([90, 0, 0]) carries +Y to +Z, and +X to +Y.
  const both = placement([1, 2, 3], [90, 0, 90]);
  near(both[1 * 4 + 0], 1);
  near(both[2 * 4 + 1], 1);
  assert.deepEqual([both[3], both[7], both[11]], [1, 2, 3]);
  const product = multiply(placement([5, 0, 0], [0, 0, 0]), axisRotation([0, 0, 1], 90));
  near(product[0], 0);
  near(product[4], 1);
  near(product[3], 5);
});

test('the swivel arm builds four parts and poses them with its joints', async () => {
  const model = await builder.build(swivelArm, 'swivel_arm.scad');
  const { assembly, meshes, partMesh, isAssembly, rebuilt } = model.preview;
  assert.equal(isAssembly, true);
  assert.deepEqual(assembly.parts.map((part) => part.name), ['base', 'turret', 'arm', 'carriage']);
  assert.deepEqual(assembly.joints.map((joint) => [joint.name, joint.type, joint.value]),
    [['swivel', 'hinge', 25], ['lift', 'hinge', 30], ['reach', 'slider', 20]]);
  assert.equal(meshes.length, 4);
  assert.equal(rebuilt, 4);
  assert.deepEqual(assembly.parts[3].color.map((c) => Math.round(c * 255)), [0xc0, 0x60, 0x4c]);
  // Shared parameters reach the joints: 110 - 4 - 13 - 30 - 3.
  assert.deepEqual(assembly.joints[2].limits, [0, 60]);
  for (const mesh of meshes) assert.ok(mesh.indices.length > 30 && mesh.volume > 0);

  // With every joint at zero the arm lies along +X at the pivot height.
  const flat = solvePose(assembly, { swivel: 0, lift: 0, reach: 0 });
  assert.deepEqual([flat[2][3], flat[2][7], flat[2][11]], [0, 0, 52]);
  assert.deepEqual([flat[3][3], flat[3][7], flat[3][11]], [30, 0, 52]);
  // Lifting by 60 degrees raises the carriage along the tilted arm.
  const up = solvePose(assembly, { swivel: 0, lift: 60, reach: 40 });
  near(up[3][3], 70 * Math.cos(Math.PI / 3));
  near(up[3][11], 52 + 70 * Math.sin(Math.PI / 3));
  // The lift hinge stops at its 75 degree limit.
  near(solvePose(assembly, { swivel: 0, lift: 90, reach: 40 })[3][3], 70 * Math.cos(75 * Math.PI / 180));
  // Swivelling by 90 degrees carries the flat arm onto +Y.
  const side = solvePose(assembly, { swivel: 90, lift: 0, reach: 10 });
  near(side[3][3], 0);
  near(side[3][7], 40);
  // Values outside the limits stop at the limit.
  near(solvePose(assembly, { swivel: 0, lift: 0, reach: 500 })[3][3], 90);

  const bounds = poseBounds(assembly, partMesh.map((i) => meshes[i].bounds), { swivel: 0, lift: 0, reach: 0 });
  near(bounds.min[0], -40, 1e-3);
  near(bounds.max[0], 110, 1e-3);
  near(bounds.min[2], 0, 1e-3);
});

test('the posed assembly exports as a STEP assembly that reads back in place', async () => {
  const model = await builder.build(swivelArm, 'swivel_arm.scad');
  assert.equal(model.preview.rebuilt, 0, 'an unchanged project reuses every solid');
  const pose = { swivel: 90, lift: 0, reach: 10 };
  const bytes = builder.exportStep(model, pose);
  await writeFile(new URL('swivel_arm.step', output), bytes);
  const step = new TextDecoder().decode(bytes);
  assert.match(step, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  assert.equal(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g)?.length, 4);
  for (const name of ['base', 'turret', 'arm', 'carriage', 'swivel_arm']) assert.ok(step.includes(`'${name}'`), `Expected ${name} in STEP`);
  assert.ok(step.includes('CYLINDRICAL_SURFACE'));
  assert.ok(step.includes('COLOUR_RGB'));

  // Read the file back as plain geometry and compare with the pose solved in the viewer.
  const mark = kernel.checkpoint();
  const shape = kernel.importStep(step);
  assert.equal(kernel.subShapeCount(shape, 'solid'), 4);
  const box = kernel.getBoundingBox(shape);
  const { assembly, meshes, partMesh } = model.preview;
  const expected = poseBounds(assembly, partMesh.map((i) => meshes[i].bounds), pose);
  near(box.xmin, expected.min[0], 0.05);
  near(box.xmax, expected.max[0], 0.05);
  near(box.ymin, expected.min[1], 0.05);
  near(box.ymax, expected.max[1], 0.05);
  near(box.zmin, expected.min[2], 0.05);
  near(box.zmax, expected.max[2], 0.05);
  // Swivelled by 90 degrees, the arm reaches along +Y instead of +X.
  near(box.ymax, 110, 0.05);
  near(kernel.getVolume(shape), meshes.reduce((sum, mesh) => sum + mesh.volume, 0), 1e-3);
  kernel.releaseSince(mark);

  const document = kernel.importXCAFFromSTEP(step);
  const [root] = document.getRoots();
  const names = document.getChildren(root).map((label) => document.getLabelInfo(label).name);
  assert.deepEqual(names, ['base', 'turret', 'arm', 'carriage']);
  document.close();
});

test('editing one part rebuilds only that part, and a shared parameter rebuilds its users', async () => {
  const longer = { ...swivelArm, 'carriage.scad': swivelArm['carriage.scad'].replace('d = 10', 'd = 8') };
  assert.equal((await builder.build(longer, 'swivel_arm.scad')).preview.rebuilt, 1);
  const wider = { ...swivelArm, 'params.scad': swivelArm['params.scad'].replace('arm_length = 110;', 'arm_length = 140;') };
  const model = await builder.build(wider, 'swivel_arm.scad');
  assert.equal(model.preview.rebuilt, 2, 'the arm changes, and the carriage returns to its first shape');
  assert.deepEqual(model.preview.assembly.joints[2].limits, [0, 90]);
  // A part file still builds alone.
  const alone = await builder.build(swivelArm, 'arm.scad');
  assert.equal(alone.preview.isAssembly, false);
  assert.equal(alone.preview.assembly.parts.length, 1);
  assert.match(new TextDecoder().decode(builder.exportStep(alone)), /MANIFOLD_SOLID_BREP/);
});

test('two parts from one file share a solid and keep their own places', async () => {
  const model = await builder.build(pair(`
    part("left", "a.scad");
    part("right", "a.scad", at = [30, 0, 0], rot = [0, 0, 90]);
    part("post", "b.scad", color = [0.2, 0.4, 0.6]);
    joint("mount", parent = "left", child = "post", at = [3.25, 3, 10]);
  `), 'main.scad');
  assert.equal(model.preview.meshes.length, 2);
  assert.deepEqual(model.preview.partMesh, [0, 0, 1]);
  assert.equal(model.solids[0], model.solids[1]);
  const world = solvePose(model.preview.assembly, defaultPose(model.preview.assembly));
  assert.deepEqual([world[2][3], world[2][7], world[2][11]], [3.25, 3, 10]);
  const step = new TextDecoder().decode(builder.exportStep(model));
  const shape = kernel.importStep(step);
  const box = kernel.getBoundingBox(shape);
  near(box.xmin, 0, 0.01);
  near(box.xmax, 30, 0.01);
  near(box.zmax, 30, 0.01);
  near(kernel.getVolume(shape), 2 * 1000 + 320, 1e-3);
});

test('positions keep more precision than the OpenSCAD console prints', async () => {
  const model = await builder.build(pair(`
    part("a", "a.scad", at = [123.456789, -0.000004, 1 / 3]);
    part("b", "b.scad");
    joint("s", type = "slider", parent = "a", child = "b", axis = [0, 3, 4], limits = [-2.5, 1234.5678], value = 1234.5678);
  `), 'main.scad');
  const [a] = model.preview.assembly.parts;
  near(a.at[0], 123.456789, 1e-9);
  near(a.at[1], -0.000004, 1e-9);
  near(a.at[2], 1 / 3, 1e-6);
  const [slide] = model.preview.assembly.joints;
  assert.deepEqual(slide.axis.map((v) => Math.round(v * 1e9) / 1e9), [0, 0.6, 0.8]);
  near(slide.value, 1234.5678, 1e-9);
});

test('assembly mistakes are explained', async () => {
  const run = (assembly: string) => builder.build(pair(assembly), 'main.scad');
  await assert.rejects(run('part("a", "missing.scad");'), /missing\.scad is not in this project/);
  await assert.rejects(run('part("a", "a.scad"); part("a", "b.scad");'), /used twice/);
  await assert.rejects(run('part("a", "a.scad"); joint("j", parent = "a", child = "ghost");'), /child "ghost" is not a part/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad"); joint("j", type = "wheel", parent = "a", child = "b");'), /type must be/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad"); joint("j", type = "slider", parent = "a", child = "b");'), /slider needs limits/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad"); joint("j", type = "hinge", parent = "a", child = "b", limits = [0, 90], value = 120);'), /outside limits/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad"); joint("j", type = "hinge", parent = "a", child = "b", axis = [0, 0, 0]);'), /axis needs a direction/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad"); joint("j", parent = "a", child = "b"); joint("k", parent = "b", child = "a");'), /form a loop/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad"); joint("j", parent = "a", child = "b"); joint("k", parent = "a", child = "b");'), /already carried/);
  await assert.rejects(run('part("a", "a.scad"); part("b", "b.scad", at = [1, 0, 0]); joint("j", parent = "a", child = "b");'), /Place it with the joint/);
  await assert.rejects(run('part("a", "a.scad"); cube(3);'), /Move the shapes into a part file/);
  await assert.rejects(run('part("a", "main.scad");'), /cannot use itself/);
  await assert.rejects(run('part("a", "a.scad", colour = "red");'), { file: 'main.scad', line: 1 });
  await assert.rejects(builder.build({ ...pair('part("a", "a.scad");'), 'a.scad': 'cube(2); translate([5, 0, 0]) cube(2);' }, 'main.scad'),
    { message: /2 separate solids/, file: 'a.scad' });
  await assert.rejects(builder.build({ ...pair('part("a", "a.scad");'), 'a.scad': 'cube(2);\nnope();' }, 'main.scad'), { file: 'a.scad', line: 2 });
  await assert.rejects(builder.build({ 'main.scad': 'include <lib.scad>\ncube(1);' }, 'main.scad'), /lib\.scad is not in this project/);
  await assert.rejects(builder.build({ 'main.scad': 'use <MCAD/boxes.scad>\ncube(1);' }, 'main.scad'), /External libraries/);
  await assert.rejects(builder.build({ 'main.scad': 'include <lib.scad>\ncube(w);', 'lib.scad': 'w = ;' }, 'main.scad'), { file: 'lib.scad', line: 1 });
});

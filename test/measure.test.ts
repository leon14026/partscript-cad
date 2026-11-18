import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { swivelArm } from '../src/assemblyExample.ts';
import { defaultPose } from '../src/engine/assembly.ts';
import { ModelBuilder, type BuiltModel } from '../src/engine/build.ts';
import { examples } from '../src/examples.ts';
import type { MeasurePick, MeasureResult, Reading } from '../src/engine/protocol.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

function near(actual: number, expected: number, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

const example = (name: string) => examples.find((item) => item.name === name)!;

async function buildExample(name: string) {
  const { filename, source } = example(name);
  return builder.build({ [filename]: source }, filename);
}

function value(readings: Reading[], label: string) {
  const found = readings.find((reading) => reading.label === label);
  assert.ok(found, `no "${label}" in ${JSON.stringify(readings)}`);
  return found.value;
}

const labels = (readings: Reading[]) => readings.map((reading) => reading.label);

/** The faces of an exact part in the part's own coordinates, with the index a pick uses. */
function faces(model: BuiltModel, part: number) {
  const entry = model.entries[part];
  assert.equal(entry.kind, 'exact');
  return kernel.getSubShapes(entry.shape, 'face').map((face, index) => {
    const data = kernel.surfaceData(face);
    return { index, kind: data.kind, data, area: kernel.getSurfaceArea(face) };
  });
}

function edges(model: BuiltModel, part: number) {
  const entry = model.entries[part];
  assert.equal(entry.kind, 'exact');
  return kernel.getSubShapes(entry.shape, 'edge').map((edge, index) => ({ index, data: kernel.curveData(edge), length: kernel.curveLength(edge) }));
}

function corners(model: BuiltModel, part: number) {
  const entry = model.entries[part];
  assert.equal(entry.kind, 'exact');
  return kernel.getSubShapes(entry.shape, 'vertex').map((vertex, index) => ({ index, at: kernel.vertexPosition(vertex) }));
}

const face = (part: number, index: number): MeasurePick => ({ part, type: 'face', index });
const edge = (part: number, index: number): MeasurePick => ({ part, type: 'edge', index });
const corner = (part: number, index: number): MeasurePick => ({ part, type: 'vertex', index });

function read(model: BuiltModel, picks: MeasurePick[], pose = defaultPose(model.assembly)): MeasureResult {
  return builder.measure(model, pose, picks);
}

test('mounting plate: a hole reads diameter 5 and length 6, and hole pairs read 64 and 24 apart', async () => {
  const model = await buildExample('Mounting plate');
  const holes = faces(model, 0).filter((item) => item.kind === 'cylinder');
  assert.equal(holes.length, 4);
  const at = (x: number, y: number) => holes.find((item) => item.data.kind === 'cylinder' && Math.abs(item.data.location.x - x) < 1e-6 && Math.abs(item.data.location.y - y) < 1e-6)!;
  const [h00, h10, h01, h11] = [at(8, 8), at(72, 8), at(8, 32), at(72, 32)];

  const one = read(model, [face(0, h00.index)]);
  assert.equal(one.items.length, 1);
  assert.deepEqual(labels(one.items[0].readings), ['Diameter', 'Length', 'Area']);
  near(value(one.items[0].readings, 'Diameter'), 5);
  near(value(one.items[0].readings, 'Length'), 6, 1e-3);
  near(value(one.items[0].readings, 'Area'), Math.PI * 5 * 6, 1e-6);
  assert.deepEqual(one.between, []);

  const alongX = read(model, [face(0, h00.index), face(0, h10.index)]);
  near(value(alongX.between, 'Centre-to-centre distance'), 64);
  near(value(alongX.between, 'Angle'), 0);
  near(value(alongX.between, 'Shortest distance'), 64 - 5);
  assert.ok(alongX.line, 'the distance has a line to draw');
  const [from, to] = alongX.line!;
  near(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]), 64);

  const alongY = read(model, [face(0, h00.index), face(0, h01.index)]);
  near(value(alongY.between, 'Centre-to-centre distance'), 24);
  const diagonal = read(model, [face(0, h00.index), face(0, h11.index)]);
  near(value(diagonal.between, 'Centre-to-centre distance'), Math.hypot(64, 24));
});

test('mounting plate: the top and bottom faces are parallel and 6 apart, and a long edge reads 80', async () => {
  const model = await buildExample('Mounting plate');
  const planes = faces(model, 0).filter((item) => item.kind === 'plane');
  const big = planes.filter((item) => Math.abs(item.area - (80 * 40 - 4 * Math.PI * 2.5 ** 2)) < 1e-6);
  assert.equal(big.length, 2, 'top and bottom');
  const result = read(model, [face(0, big[0].index), face(0, big[1].index)]);
  near(value(result.between, 'Distance between faces'), 6);
  near(value(result.between, 'Angle'), 0);
  assert.equal(labels(result.between).includes('Shortest distance'), false, 'it would repeat the distance');
  near(value(result.items[0].readings, 'Area'), 80 * 40 - 4 * Math.PI * 2.5 ** 2, 1e-6);

  const side = planes.find((item) => item.data.kind === 'plane' && Math.abs(item.data.normal.x) > 0.99)!;
  const crossing = read(model, [face(0, big[0].index), face(0, side.index)]);
  near(value(crossing.between, 'Angle'), 90);
  assert.equal(crossing.line, undefined, 'faces that are not parallel have no distance line');

  const long = edges(model, 0).find((item) => item.data.kind === 'line' && Math.abs(item.length - 80) < 1e-9)!;
  near(value(read(model, [edge(0, long.index)]).items[0].readings, 'Length'), 80);
});

test('mounting plate: circular edges, corners and a corner against a face', async () => {
  const model = await buildExample('Mounting plate');
  const rims = edges(model, 0).filter((item) => item.data.kind === 'circle' && Math.abs(item.data.center.z - 6) < 1e-9);
  assert.equal(rims.length, 4);
  const rim = (x: number, y: number) => rims.find((item) => item.data.kind === 'circle' && Math.abs(item.data.center.x - x) < 1e-6 && Math.abs(item.data.center.y - y) < 1e-6)!;
  const single = read(model, [edge(0, rim(8, 8).index)]);
  assert.deepEqual(labels(single.items[0].readings), ['Diameter', 'Length']);
  near(value(single.items[0].readings, 'Diameter'), 5);
  near(value(single.items[0].readings, 'Length'), Math.PI * 5, 1e-6);
  near(value(read(model, [edge(0, rim(8, 8).index), edge(0, rim(72, 8).index)]).between, 'Centre-to-centre distance'), 64);

  const all = corners(model, 0);
  const origin = all.find((item) => Math.hypot(item.at.x, item.at.y, item.at.z) < 1e-9)!;
  const far = all.find((item) => Math.abs(item.at.x - 80) < 1e-9 && Math.abs(item.at.y - 40) < 1e-9 && Math.abs(item.at.z - 6) < 1e-9)!;
  const here = read(model, [corner(0, far.index)]);
  assert.deepEqual([value(here.items[0].readings, 'X'), value(here.items[0].readings, 'Y'), value(here.items[0].readings, 'Z')], [80, 40, 6]);
  const span = read(model, [corner(0, origin.index), corner(0, far.index)]);
  near(value(span.between, 'Distance'), Math.sqrt(80 ** 2 + 40 ** 2 + 6 ** 2));
  near(value(span.between, 'ΔX'), 80);
  assert.deepEqual(span.line, [[0, 0, 0], [80, 40, 6]]);

  // The origin against the top face: the face is 6 above it, and the foot of the perpendicular is on the face.
  const top = faces(model, 0).find((item) => item.kind === 'plane' && Math.abs(item.area - (3200 - 4 * Math.PI * 2.5 ** 2)) < 1e-6 && item.data.kind === 'plane' && item.data.location.z > 5)!;
  const against = read(model, [corner(0, origin.index), face(0, top.index)]);
  near(value(against.between, 'Shortest distance'), 6);
  assert.deepEqual(against.line?.map((p) => p.map((c) => Math.round(c * 1e6) / 1e6)), [[0, 0, 0], [0, 0, 6]]);

  // A hole's axis stands square to the top face.
  const hole = faces(model, 0).find((item) => item.kind === 'cylinder')!;
  near(value(read(model, [face(0, hole.index), face(0, top.index)]).between, 'Angle'), 90);
});

test('tapered spacer: the bore reads diameter 8, the cone has a half angle and no diameter', async () => {
  const model = await buildExample('Tapered spacer');
  const all = faces(model, 0);
  const bore = all.find((item) => item.kind === 'cylinder')!;
  near(value(read(model, [face(0, bore.index)]).items[0].readings, 'Diameter'), 8);
  const cone = all.find((item) => item.kind === 'cone')!;
  const readings = read(model, [face(0, cone.index)]).items[0].readings;
  assert.equal(labels(readings).includes('Diameter'), false);
  // The wall narrows by 4 mm of radius over 12 mm of height.
  near(value(readings, 'Half angle'), (Math.atan(4 / 12) * 180) / Math.PI, 1e-6);
  near(value(readings, 'Area'), Math.PI * (14 + 10) * Math.hypot(4, 12), 1e-3);
  // The bore and the cone share an axis.
  const coaxial = read(model, [face(0, bore.index), face(0, cone.index)]).between;
  near(value(coaxial, 'Angle'), 0);
  near(value(coaxial, 'Centre-to-centre distance'), 0, 1e-6);
  // The bore wall (radius 4) is 6 mm from the cone wall where it is narrowest (radius 10, at the top).
  near(value(coaxial, 'Shortest distance'), 6, 1e-6);
});

test('swivel arm: the angle between the base top and the arm top follows the lift joint', async () => {
  const model = await builder.build(swivelArm, 'swivel_arm.scad');
  // A plane's own normal ignores which way the solid's outside faces, so the top is told from the bottom by its height.
  const topOf = (part: number, z: number) => faces(model, part).filter((item) => item.data.kind === 'plane' && Math.abs(item.data.normal.z) > 0.99 && Math.abs(item.data.location.z - z) < 1e-9).sort((a, b) => b.area - a.area)[0];
  const [base, arm] = [model.assembly.parts.findIndex((part) => part.name === 'base'), model.assembly.parts.findIndex((part) => part.name === 'arm')];
  const picks = [face(base, topOf(base, 8).index), face(arm, topOf(arm, 6).index)];
  const pose = defaultPose(model.assembly);
  assert.equal(pose.lift, 30);
  near(value(read(model, picks, pose).between, 'Angle'), 30, 1e-6);
  near(value(read(model, picks, { ...pose, lift: 45 }).between, 'Angle'), 45, 1e-6);
  // Level, the two faces are parallel. The base top is at z = 8. The swivel joint is at 8 + 14 = 22, the lift pivot 30 above it,
  // and the arm's top face is 6 above the pivot axis (half of arm_height): 22 + 30 + 6 = 58, which is 50 above the base top.
  const level = read(model, picks, { ...pose, lift: 0 });
  near(value(level.between, 'Angle'), 0, 1e-6);
  near(value(level.between, 'Distance between faces'), 50, 1e-6);
});

test('swivel arm: positions are in the current pose', async () => {
  const model = await builder.build(swivelArm, 'swivel_arm.scad');
  const carriage = model.assembly.parts.findIndex((part) => part.name === 'carriage');
  const first = corners(model, carriage)[0];
  const pose = defaultPose(model.assembly);
  const at = (reach: number) => {
    const { readings } = read(model, [corner(carriage, first.index)], { ...pose, reach }).items[0];
    return [value(readings, 'X'), value(readings, 'Y'), value(readings, 'Z')];
  };
  const [near0, far] = [at(0), at(20)];
  near(Math.hypot(far[0] - near0[0], far[1] - near0[1], far[2] - near0[2]), 20, 1e-6);
  // Two readings of the same corner at one pose agree with the distance the corner-to-corner reading gives.
  const other = corners(model, carriage)[3];
  const together = read(model, [corner(carriage, first.index), corner(carriage, other.index)], { ...pose, reach: 20 });
  const a = read(model, [corner(carriage, first.index)], { ...pose, reach: 20 }).items[0].readings;
  const b = read(model, [corner(carriage, other.index)], { ...pose, reach: 20 }).items[0].readings;
  near(value(together.between, 'Distance'), Math.hypot(value(a, 'X') - value(b, 'X'), value(a, 'Y') - value(b, 'Y'), value(a, 'Z') - value(b, 'Z')), 1e-9);
});

test('the faces of every part of the swivel arm come in the order the preview numbers them', async () => {
  const model = await builder.build(swivelArm, 'swivel_arm.scad');
  assert.equal(model.assembly.parts.length, 4);
  model.assembly.parts.forEach((_, part) => {
    const { mesh } = model.entries[part];
    const exact = faces(model, part);
    assert.equal(new Set(mesh.faceOf).size, exact.length, `part ${part}: every face has triangles`);
    const sum = new Float64Array(exact.length);
    for (let t = 0; t < mesh.faceOf.length; t++) {
      const p = (k: number) => [0, 1, 2].map((axis) => mesh.positions[mesh.indices[t * 3 + k] * 3 + axis]);
      const [a, b, c] = [p(0), p(1), p(2)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      sum[mesh.faceOf[t]] += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    exact.forEach((item) => assert.ok(Math.abs(sum[item.index] - item.area) <= 5e-3 * item.area, `part ${part} face ${item.index}: ${sum[item.index]} against ${item.area}`));
  });
});

test('a faceted part reads areas and corners, and refuses what its mesh cannot give', async () => {
  const source = `polyhedron(points = [[0,0,0],[10,0,0],[10,7,0],[0,7,0],[0,0,5],[10,0,5],[10,7,5],[0,7,5]],
    faces = [[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]);`;
  const model = await builder.build({ 'block.scad': source }, 'block.scad');
  assert.equal(model.entries[0].kind, 'faceted');
  const areas = [0, 1, 2, 3, 4, 5].map((index) => value(read(model, [face(0, index)]).items[0].readings, 'Area')).sort((a, b) => a - b);
  [35, 35, 50, 50, 70, 70].forEach((expected, i) => near(areas[i], expected, 1e-4));
  assert.equal(read(model, [face(0, 0)]).notes.length, 1, 'a note says the mesh was measured');

  const at = (index: number) => {
    const { readings } = read(model, [corner(0, index)]).items[0];
    return [value(readings, 'X'), value(readings, 'Y'), value(readings, 'Z')];
  };
  assert.equal(model.entries[0].mesh.corners.length / 3, 8);
  const all = [0, 1, 2, 3, 4, 5, 6, 7].map(at);
  const origin = all.findIndex((p) => p.every((c) => Math.abs(c) < 1e-6));
  const far = all.findIndex((p) => Math.abs(p[0] - 10) < 1e-6 && Math.abs(p[1] - 7) < 1e-6 && Math.abs(p[2] - 5) < 1e-6);
  assert.ok(origin >= 0 && far >= 0);
  near(value(read(model, [corner(0, origin), corner(0, far)]).between, 'Distance'), Math.sqrt(174), 1e-5);

  const faces2 = read(model, [face(0, 0), face(0, 1)]);
  assert.deepEqual(faces2.between, []);
  assert.ok(faces2.notes.some((note) => note.includes('exact parts')));
  assert.throws(() => read(model, [edge(0, 0)]), /faceted part.*edges cannot be measured/);
});

test('a pick that is not in the model, or the wrong number of picks, is refused with a message', async () => {
  const model = await buildExample('Mounting plate');
  assert.throws(() => read(model, [face(0, 99)]), /Run the code again/);
  assert.throws(() => read(model, [face(3, 0)]), /not in the current model/);
  assert.throws(() => read(model, []), /one or two/);
  assert.throws(() => read(model, [face(0, 0), face(0, 1), face(0, 2)]), /one or two/);
});

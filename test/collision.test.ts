import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { solvePose } from '../src/engine/assembly.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import { CadError, type ProjectFiles } from '../src/engine/protocol.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
import { CollisionChecker, clearMove, overlapFloor, pairKey, rigidGroups, sweepJoint, trianglesCross } from '../src/collision.ts';
import { crankRocker } from '../src/linkageExample.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

after(() => kernel.releaseAll());

function near(actual: number, expected: number, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

async function model(source: string, files: ProjectFiles = {}) {
  const built = await builder.build({ 'a.scad': source, ...files }, 'a.scad');
  const meshes = built.preview.partMesh.map((i) => built.preview.meshes[i]);
  return { built, checker: new CollisionChecker(built.assembly, meshes), world: (pose = {}) => solvePose(built.assembly, pose) };
}

/** The names of the parts that collide in the opening pose. */
async function colliding(source: string) {
  const { built, checker, world } = await model(source);
  return checker.check(world()).map((hit) => `${built.assembly.parts[hit.a].name}+${built.assembly.parts[hit.b].name} ${hit.kind}`);
}

test('two 10 mm cubes: overlapping 2 mm collide, and cubes that touch on a face, along an edge, at a corner or are apart do not', async () => {
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [8, 0, 0]) cube(10);'), ['a+b crossing']);
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [8, 8, 8]) cube(10);'), ['a+b crossing']);
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [10, 0, 0]) cube(10);'), []);
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [10, 3, 0]) cube(10);'), [], 'a face that only partly meets another');
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [10, 10, 0]) cube(10);'), [], 'an edge');
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [10, 10, 10]) cube(10);'), [], 'a corner');
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [10.5, 0, 0]) cube(10);'), []);
  // 0.01 mm of overlap is found too, and 0.0001 mm sits under what the preview mesh can resolve.
  assert.deepEqual(await colliding('part("a") cube(10); part("b", at = [9.99, 0, 0]) cube(10);'), ['a+b crossing']);
});

test('a 6 mm cube inside a 10 mm cube has no crossing triangles and is found by ray parity; one in a cavity is not a collision', async () => {
  assert.deepEqual(await colliding('part("big") cube(10); part("small", at = [2, 2, 2]) cube(6);'), ['big+small nested']);
  assert.deepEqual(await colliding('part("small", at = [2, 2, 2]) cube(6); part("big") cube(10);'), ['small+big nested'], 'whichever is written first');
  // The same cube sitting in a hollow of a 20 mm block is clear: it only seems to be inside.
  const block = 'difference() { cube(20); translate([4, 4, 4]) cube(12); }';
  assert.deepEqual(await colliding(`part("block") ${block} part("ball", at = [8, 8, 8]) cube(4);`), []);
  // A part in a part with two bodies: the body that is inside is found, and the part's first body is not inside anything.
  assert.deepEqual(await colliding('part("big") cube(10); part("pair") { translate([30, 0, 0]) cube(2); translate([4, 4, 4]) cube(2); }'), ['big+pair nested']);
});

test('the lines where two surfaces cross are in world coordinates, on the faces of both cubes', async () => {
  const { checker, world } = await model('part("a", at = [100, 0, 0]) cube(10); part("b", at = [108, 0, 0]) cube(10);');
  const [hit] = checker.check(world());
  assert.ok(hit && hit.segments.length >= 6 && hit.segments.length % 6 === 0);
  // The cubes share x from 108 to 110, y and z from 0 to 10. Each end of each line is on a face of one of them.
  for (let i = 0; i < hit.segments.length; i += 3) {
    const [x, y, z] = [hit.segments[i], hit.segments[i + 1], hit.segments[i + 2]];
    assert.ok(x > 107.999 && x < 110.001 && y > -0.001 && y < 10.001 && z > -0.001 && z < 10.001, `${x} ${y} ${z} is outside the shared box`);
    const onFace = [Math.abs(x - 108) < 1e-3, Math.abs(x - 110) < 1e-3, Math.abs(y) < 1e-3, Math.abs(y - 10) < 1e-3, Math.abs(z) < 1e-3, Math.abs(z - 10) < 1e-3].some(Boolean);
    assert.ok(onFace, `${x} ${y} ${z} is on no face`);
  }
  assert.equal(checker.check(world(), false)[0].segments.length, 0, 'without collect, no lines are kept');
});

test('trianglesCross: crossing triangles give their line, and triangles that touch or lie in one plane give a line only when their bodies overlap there', () => {
  const flat = [0, 0, 0, 10, 0, 0, 0, 10, 0];
  const out: number[] = [];
  // A triangle through the flat one, from z = -1 to z = 1. It meets the plane z = 0 from (2, 2, 0) to (6, 2, 0), and the flat triangle
  // covers x from 0 to 8 at y = 2, so the line is the whole of that segment.
  assert.equal(trianglesCross(flat, [2, 2, -1, 2, 2, 1, 6, 2, 0], 1e-6, out), true);
  const ends = [out.slice(0, 3), out.slice(3, 6)].sort((p, q) => p[0] - q[0]);
  assert.deepEqual(ends.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)), [[2, 2, 0], [6, 2, 0]]);
  // Across the plane at y = 2 as well, but from x = 7 to x = 12: the flat triangle ends at x = 8, so the line is from 7 to 8.
  out.length = 0;
  assert.equal(trianglesCross(flat, [7, 2, -1, 7, 2, 1, 12, 2, 0], 1e-6, out), true);
  assert.equal(Math.round(Math.abs(out[3] - out[0]) * 1e6) / 1e6, 1);
  // In the same plane, facing the same way: the two bodies are on the same side, so they overlap. The line is the edges of the shared 2 mm2.
  out.length = 0;
  assert.equal(trianglesCross(flat, [1, 1, 0, 3, 1, 0, 1, 3, 0], 1e-6, out), true);
  assert.equal(out.length, 18, 'three edges');
  // In the same plane, facing the other way: the bodies are on opposite sides, so they only touch.
  assert.equal(trianglesCross(flat, [1, 1, 0, 1, 3, 0, 3, 1, 0], 1e-6, []), false);
  assert.equal(trianglesCross(flat, [1, 1, 0, 3, 1, 1, 1, 3, 1], 1e-6, []), false, 'one corner on the plane and the rest above it');
  assert.equal(trianglesCross(flat, [20, 20, -1, 22, 20, 1, 20, 22, 1], 1e-6, []), false, 'across the plane but far from the triangle');
  assert.equal(trianglesCross(flat, [20, 20, 0, 22, 20, 0, 20, 22, 0], 1e-6, []), false, 'in the plane but apart');
});

test('parts joined by fixed joints, and parts that no joint carries, are one rigid group; a hinge starts another', async () => {
  const { built } = await model(`
part("frame") cube(10);
part("guard") cube(5);
part("arm") cube(5);
part("tool") cube(5);
part("floor", at = [0, 0, -20]) cube(5);
joint("g", type = "fixed", parent = "frame", child = "guard");
joint("h", type = "hinge", parent = "frame", child = "arm", limits = [0, 90]);
joint("t", type = "fixed", parent = "arm", child = "tool");`);
  const groups = rigidGroups(built.assembly);
  const names = built.assembly.parts.map((part) => part.name);
  const same = (a: string, b: string) => groups[names.indexOf(a)] === groups[names.indexOf(b)];
  assert.ok(same('frame', 'guard') && same('frame', 'floor') && same('arm', 'tool'));
  assert.ok(!same('frame', 'arm') && !same('guard', 'tool'));
});

test('allow_overlap removes a pair from every check, and a name that is not a part is explained', async () => {
  // b and c share the corner block x and y from 8 to 10 as well, so all three pairs collide.
  const source = 'part("a") cube(10); part("b", at = [8, 0, 0]) cube(10); part("c", at = [0, 8, 0]) cube(10);';
  assert.deepEqual(await colliding(source), ['a+b crossing', 'a+c crossing', 'b+c crossing']);
  assert.deepEqual(await colliding(`${source} allow_overlap("b", "a");`), ['a+c crossing', 'b+c crossing']);
  const { built } = await model(`${source} allow_overlap("a", "b"); allow_overlap("b", "a");`);
  assert.deepEqual(built.assembly.allowed, [['a', 'b']], 'the same pair twice is one');
  await assert.rejects(model(`${source} allow_overlap("a", "plate");`), (error: unknown) => error instanceof CadError && error.message === 'allow_overlap("a", "plate"): "plate" is not a part. Declare it with part(), or check the name.');
  await assert.rejects(model(`${source} allow_overlap("a", "a");`), (error: unknown) => error instanceof CadError && /give two different parts/.test(error.message));
  await assert.rejects(model(`${source} allow_overlap("a");`), (error: unknown) => error instanceof CadError && error.message === 'allow_overlap(): give two part names in quotes, for example allow_overlap("shaft", "plate").');
});


/** The exact overlap volumes of the pairs the quick test calls colliding, as the worker would confirm them. */
async function confirmed(source: string, pose = {}) {
  const { built, checker, world } = await model(source);
  const hits = checker.check(world(pose), false);
  const [answer] = builder.collide(built, [{ pose, pairs: hits.map((hit) => [hit.a, hit.b]) }]).volumes;
  return { hits, volumes: answer, built };
}

test('the exact volume: cubes 2 mm into each other give 200, cubes that touch give 0, a cube 2 mm inside another gives 216', async () => {
  const volume = async (source: string) => {
    const { built } = await model(source);
    return builder.collide(built, [{ pose: {}, pairs: [[0, 1]] }]).volumes[0][0];
  };
  near((await volume('part("a") cube(10); part("b", at = [8, 0, 0]) cube(10);'))!, 200, 1e-6);
  near((await volume('part("a") cube(10); part("b", at = [10, 0, 0]) cube(10);'))!, 0, 1e-9);
  near((await volume('part("a") cube(10); part("b", at = [10, 10, 10]) cube(10);'))!, 0, 1e-9);
  near((await volume('part("big") cube(10); part("small", at = [2, 2, 2]) cube(6);'))!, 216, 1e-6);
  near((await volume('part("a") cube(10); part("b", at = [9.99, 0, 0]) cube(10);'))!, 1, 1e-6);
});

/** A 30 mm plate 10 mm thick with a hole of radius 5.1, and a shaft through it. Both are 64-sided prisms, exact. */
const shaftIn = (radius: number) => `
  part("plate") difference() { translate([-15, -15, 0]) cube([30, 30, 10]); translate([0, 0, -1]) cylinder(r = 5.1, h = 12, $fn = 64); }
  part("shaft") translate([0, 0, -5]) cylinder(r = ${radius}, h = 20, $fn = 64);`;

test('a shaft of radius 5.0 in a hole of radius 5.1 is clear, and one of 5.2 overlaps by the hand-worked volume of the ring', async () => {
  const clear = await confirmed(shaftIn(5));
  assert.deepEqual(clear.hits, []);
  const tight = await confirmed(shaftIn(5.2));
  assert.equal(tight.hits.length, 1);
  // Both are 64-sided prisms with their corners in line, so the ring between them is a difference of two polygon areas, 10 mm deep.
  const area = (r: number) => 32 * r * r * Math.sin((2 * Math.PI) / 64);
  near(tight.volumes[0]!, 10 * (area(5.2) - area(5.1)), 1e-6);
  assert.ok(tight.built.entries.every((entry) => entry.kind === 'exact'));
});

/** The same plate and shaft with true circles (no $fn), so the preview meshes are 70-sided and lie inside the round surfaces (F31). */
const roundShaftIn = (radius: number, turn = 0) => `
  part("plate") difference() { translate([-15, -15, 0]) cube([30, 30, 10]); translate([0, 0, -1]) cylinder(r = 5.1, h = 12); }
  part("shaft") translate([0, 0, -5]) rotate([0, 0, ${turn}]) cylinder(r = ${radius}, h = 20);`;

test('round shafts in a round hole: 5.0 is clear, 5.2 overlaps by π (5.2² − 5.1²) 10, and 5.099 looks like a crossing on the mesh but the exact solids say it is clear', async () => {
  assert.deepEqual((await confirmed(roundShaftIn(5))).hits, []);
  const tight = await confirmed(roundShaftIn(5.2));
  assert.equal(tight.hits.length, 1);
  near(tight.volumes[0]!, Math.PI * (5.2 ** 2 - 5.1 ** 2) * 10, 1e-3);
  // A gap of 0.001 mm is less than the preview mesh's sag of 0.001 r (F31), so the mesh crosses where the solids do not touch.
  // Turned half a side (360 / 140 degrees) so that the shaft's corners meet the middle of the hole's flat sides, where the mesh lies deepest.
  const fit = await confirmed(roundShaftIn(5.099, 360 / 140));
  assert.equal(fit.hits.length, 1, 'the preview mesh sees a crossing');
  assert.ok(fit.volumes[0]! < overlapFloor, `the exact volume is ${fit.volumes[0]}`);
});

test('a faceted part has no exact answer: the pair is reported as found from the mesh only', async () => {
  const { hits, volumes, built } = await confirmed('part("a") cube(10); part("b", at = [8, 0, 0]) hull() { cube(10); translate([0, 0, 10]) cube(10); }');
  assert.equal(built.entries[1].kind, 'faceted');
  assert.equal(hits.length, 1, 'the mesh still sees the overlap');
  assert.deepEqual(volumes, [null]);
});

test('a hinge swings a bar into a wall: first contact at 27.0963 degrees, and 0.5461 mm³ at 28.0963 (F30)', async () => {
  const { built, checker } = await model(`
    part("wall") translate([-5, 10, 0]) cube([40, 2, 5]);
    part("bar") translate([0, -1, 0]) cube([20, 2, 5]);
    joint("swing", type = "hinge", parent = "wall", child = "bar", axis = [0, 0, 1], limits = [0, 40]);`);
  const result = await sweepJoint(checker, {}, 'swing');
  assert.equal(result.intervals.length, 1);
  const [found] = result.intervals;
  assert.ok(found.openTo && !found.openFrom, 'it is touching at 40 degrees and clear at 0');
  near(found.from, 27.0963, 0.01);
  const t = (28.0963 * Math.PI) / 180;
  const h = 20 * Math.sin(t) + Math.cos(t) - 10;
  const [[volume]] = builder.collide(built, [{ pose: { swing: 28.0963 }, pairs: [[0, 1]] }]).volumes;
  near(volume!, (5 * h * h) / Math.sin(2 * t), 2e-3);
  near(volume!, 0.5461, 2e-3);
});

const slider = (body = 'cube(10)') => `
  part("fixed") translate([25, 0, 0]) cube(10);
  part("block") ${body};
  joint("slide", type = "slider", parent = "fixed", child = "block", axis = [1, 0, 0], limits = [0, 30]);`;

test('a slider block runs into a fixed one: contact at 15 mm, and 5 mm of overlap at 30', async () => {
  const { built, checker } = await model(slider());
  const result = await sweepJoint(checker, {}, 'slide');
  assert.equal(result.intervals.length, 1);
  near(result.intervals[0].from, 15, 0.002); // the mesh test sees an overlap from 0.001 mm (touchDepth in collision.ts)
  assert.ok(result.intervals[0].openTo);
  near(result.intervals[0].to, 30, 1e-9);
  const [[volume]] = builder.collide(built, [{ pose: { slide: 30 }, pairs: [[0, 1]] }]).volumes;
  near(volume!, 5 * 10 * 10, 1e-6);
  // The same block in the poses of the probes: each one is inside the interval and overlaps by the hand-worked length.
  const answers = builder.collide(built, result.intervals[0].probes.map((probe) => ({ pose: probe.pose, pairs: [[0, 1]] as [number, number][] })));
  // The block spans s to s + 10 and the fixed one 25 to 35, so they share min(s + 10, 35) - max(s, 25) of x, 10 by 10 across.
  answers.volumes.forEach(([v], i) => {
    const s = result.intervals[0].probes[i].value;
    near(v!, 100 * (Math.min(s + 10, 35) - Math.max(s, 25)), 1e-3);
  });
});

test('clearMove stops a slider at the last clear value before it runs into the other part, and keeps going when nothing is in the way', async () => {
  const { checker } = await model(slider());
  const stopped = clearMove(checker, {}, 'slide', 30);
  assert.ok(stopped.blocked && !stopped.reached);
  // The quick test sees an overlap from 0.001 mm, so the last clear value is at most that far into the other block.
  assert.ok(stopped.pose.slide <= 15.002 && stopped.pose.slide > 14.998, `stopped at ${stopped.pose.slide}`);
  assert.deepEqual(stopped.by, [[0, 1]]);
  const free = clearMove(checker, {}, 'slide', 12);
  assert.ok(!free.blocked && free.reached);
  near(free.pose.slide, 12, 1e-9);
  // Starting inside the overlap, the block may be moved out of it, and is not stopped by the pair it already collides with.
  const out = clearMove(checker, { slide: 20 }, 'slide', 0);
  assert.ok(!out.blocked && out.reached);
});

test('a pair that no joint moves is tested once over a whole sweep', async () => {
  // A frame with a hollow and a guard that sits in it: their boxes overlap, so the pair is tested, and no surface crosses.
  const { checker } = await model(`
    part("frame") difference() { cube(30); translate([5, 5, 5]) cube(20); }
    part("guard") translate([12, 12, 12]) cube(6);
    part("arm") translate([40, 0, 0]) cube([4, 4, 4]);
    joint("fix", type = "fixed", parent = "frame", child = "guard");
    joint("turn", type = "hinge", parent = "frame", child = "arm", at = [35, 2, 0], limits = [0, 360]);`);
  const result = await sweepJoint(checker, {}, 'turn');
  assert.ok(result.samples > 100, `${result.samples} samples`);
  assert.equal(checker.byPair.get(pairKey(0, 1, 3))?.narrow, 1, 'frame and guard are tested once');
  assert.ok(checker.stats.reused > 100);
});

test('200 parts: the broad stage rules out all 19,900 pairs quickly', async () => {
  const { built } = await model('part("a") cube(10); part("b", at = [20, 0, 0]) cube(10);');
  const mesh = built.preview.meshes[built.preview.partMesh[0]];
  const parts = Array.from({ length: 200 }, (_, i) => ({ ...built.assembly.parts[0], name: `p${i}` }));
  const assembly = { ...built.assembly, parts, joints: [], allowed: [] };
  const checker = new CollisionChecker(assembly, parts.map(() => mesh));
  const matrices = parts.map((_, i) => [1, 0, 0, (i % 20) * 20, 0, 1, 0, Math.floor(i / 20) * 20, 0, 0, 1, 0] as const);
  const started = performance.now();
  const hits = checker.check(matrices.map((m) => [...m]) as never, false);
  const took = performance.now() - started;
  assert.deepEqual(hits, []);
  assert.equal(checker.stats.narrow, 0, 'no pair got as far as its triangles');
  assert.ok(took < 250, `${took.toFixed(0)} ms`);
});

test('a four-bar loop sweeps the whole crank turn with the loop shut', async () => {
  const built = await builder.build(crankRocker, 'four_bar.scad');
  const checker = new CollisionChecker(built.assembly, built.preview.partMesh.map((i) => built.preview.meshes[i]));
  const result = await sweepJoint(checker, {}, 'crank');
  assert.equal(result.stoppedAt, undefined, 'the loop did not jam');
  assert.equal(result.low, -180);
  assert.equal(result.high, 180);
  assert.ok(result.samples >= 361, `${result.samples} samples`);
});

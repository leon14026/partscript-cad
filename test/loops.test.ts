import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { defaultPose, followerStates, movingJoints, placement, poseBounds, solvePose, structureOf, type AssemblySpec } from '../src/engine/assembly.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import { advanceJoint, loopStates, moveJoint, openingPose, settlePose } from '../src/engine/kinematics.ts';
import type { Pose } from '../src/engine/protocol.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
import { gearedMechanism } from '../src/gearedExample.ts';
import { crankRocker } from '../src/linkageExample.ts';

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

const blocks = (assembly: string) => ({ 'a.scad': 'cube([4, 4, 4]);', 'main.scad': assembly });
async function assemblyOf(source: string) {
  return (await builder.build(blocks(source), 'main.scad')).preview.assembly;
}

/** World position of a point given in a part's own coordinates. */
function point(assembly: AssemblySpec, pose: Pose, part: string, local: number[]) {
  const m = solvePose(assembly, pose)[assembly.parts.findIndex((item) => item.name === part)];
  return [0, 1, 2].map((row) => m[row * 4] * local[0] + m[row * 4 + 1] * local[1] + m[row * 4 + 2] * local[2] + m[row * 4 + 3]);
}

const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('the crank-rocker closes, and its crank turns fully while the rocker swings', async () => {
  const model = await builder.build(crankRocker, 'four_bar.scad');
  const { assembly } = model.preview;
  const shape = structureOf(assembly);
  assert.deepEqual(shape.closures.map((j) => assembly.joints[j].name), ['rocker_pin']);
  assert.deepEqual(movingJoints(assembly).map((joint) => joint.name), ['crank', 'crank_pin', 'rocker']);
  assert.deepEqual(shape.looped, [true, true, true, false]);

  // The code's own values leave the loop open. The opening pose holds the crank and shuts it.
  assert.equal(loopStates(assembly, defaultPose(assembly))[0].closed, false);
  let { pose, closed } = openingPose(assembly);
  assert.equal(closed, true);
  near(pose.crank, 40);
  // Open form of the linkage, worked out by hand for a 40 degree crank.
  near(pose.rocker, 71.1, 0.1);
  const pinOnCoupler = () => point(assembly, pose, 'coupler', [90, 0, 0]);
  const pinOnRocker = () => point(assembly, pose, 'rocker', [60, 0, 6]);
  near(distance(pinOnCoupler(), pinOnRocker()), 0, 1e-4);

  // One full turn of the crank, a degree at a time.
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < 360; i++) {
    const moved = advanceJoint(assembly, pose, 'crank', 1);
    assert.equal(moved.reached, true, `crank stuck after ${i} degrees`);
    pose = moved.pose;
    near(distance(pinOnCoupler(), pinOnRocker()), 0, 1e-4);
    // The rocker's free end stays on its 60 mm circle about the second fixed pivot.
    near(distance(pinOnCoupler(), [80, 0, 12]), 60, 1e-4);
    low = Math.min(low, pose.rocker);
    high = Math.max(high, pose.rocker);
  }
  near(pose.crank, 40, 1e-6);
  near(pose.rocker, 71.1, 0.1);
  // Rocker limits are where crank and coupler line up: the pin is 65 or 115 from the crank pivot.
  const limit = (reach: number) => 180 - Math.acos((60 ** 2 + 80 ** 2 - reach ** 2) / (2 * 60 * 80)) * 180 / Math.PI;
  near(low, limit(115), 0.05);
  near(high, limit(65), 0.05);

  // The rocker can be dragged too, and it stops at the end of its swing.
  const pulled = moveJoint(assembly, pose, 'rocker', 100);
  assert.equal(pulled.reached, true);
  near(pulled.pose.rocker, 100);
  const blocked = moveJoint(assembly, pose, 'rocker', 170);
  assert.equal(blocked.reached, false);
  near(blocked.pose.rocker, limit(65), 0.5);
  assert.equal(loopStates(assembly, blocked.pose)[0].closed, true);

  // The exported STEP has the parts where the solved pose puts them.
  const step = new TextDecoder().decode(builder.exportStep(model, pose));
  await writeFile(new URL('four_bar.step', output), step);
  const box = kernel.getBoundingBox(kernel.importStep(step));
  const { meshes, partMesh } = model.preview;
  const expected = poseBounds(assembly, partMesh.map((i) => meshes[i].bounds), pose);
  // poseBounds boxes each turned part, so it can only be larger than the true extent.
  assert.ok(box.ymax <= expected.max[1] + 0.05 && box.xmax <= expected.max[0] + 0.05);
  near(box.zmax, 18, 0.01);
  near(box.zmin, 0, 0.01);
  // The crank's far boss, 9 mm in radius, is the highest point in Y unless the rocker's is.
  const crankPin = point(assembly, pose, 'crank', [25, 0, 0]);
  const rockerPin = point(assembly, pose, 'rocker', [60, 0, 0]);
  near(box.ymax, Math.max(crankPin[1], rockerPin[1], 22 - 9) + 9, 0.05);
  near(kernel.getVolume(kernel.importStep(step)), meshes.reduce((sum, mesh, i) => sum + mesh.volume * partMesh.filter((m) => m === i).length, 0), 1e-3);
});

test('a slider-crank follows the textbook piston position', async () => {
  const assembly = await assemblyOf(`
    part("frame", "a.scad"); part("crank", "a.scad"); part("rod", "a.scad"); part("piston", "a.scad");
    joint("crank", type = "hinge", parent = "frame", child = "crank", value = 60);
    joint("big_end", type = "hinge", parent = "crank", child = "rod", at = [20, 0, 0]);
    joint("bore", type = "slider", parent = "frame", child = "piston", axis = [1, 0, 0], limits = [0, 100], value = 60);
    joint("wrist_pin", type = "hinge", parent = "rod", child = "piston", at = [50, 0, 0]);
  `);
  let { pose, closed } = openingPose(assembly);
  assert.equal(closed, true);
  for (let i = 0; i < 72; i++) {
    const angle = pose.crank * Math.PI / 180;
    near(pose.bore, 20 * Math.cos(angle) + Math.sqrt(50 ** 2 - (20 * Math.sin(angle)) ** 2), 1e-4);
    const moved = advanceJoint(assembly, pose, 'crank', 5);
    assert.equal(moved.reached, true);
    pose = moved.pose;
  }
  // Pushing the piston turns the crank, and the piston stops at top dead centre.
  const pushed = moveJoint(assembly, pose, 'bore', 100);
  assert.equal(pushed.reached, false);
  near(pushed.pose.bore, 70, 0.05);
});

test('a loop can close through a slider, and a loop that cannot close reports its gap', async () => {
  // A scissor-style triangle: two bars hinged at the top, one foot fixed and the other on a rail.
  const assembly = await assemblyOf(`
    part("rail", "a.scad"); part("left", "a.scad"); part("right", "a.scad"); part("foot", "a.scad");
    joint("left_pivot", type = "hinge", parent = "rail", child = "left", axis = [0, -1, 0], limits = [5, 85], value = 60);
    // The guess folds the second bar back down toward the rail instead of onto the first bar.
    joint("apex", type = "hinge", parent = "left", child = "right", at = [40, 0, 0], axis = [0, -1, 0], value = -100);
    joint("right_pivot", type = "hinge", parent = "right", child = "foot", at = [40, 0, 0], axis = [0, -1, 0]);
    joint("slide", type = "slider", parent = "rail", child = "foot", axis = [1, 0, 0], limits = [0, 80]);
  `);
  assert.deepEqual(structureOf(assembly).closures.map((j) => assembly.joints[j].name), ['slide']);
  const { pose, closed } = openingPose(assembly);
  assert.equal(closed, true);
  // Bars of 40 at 60 degrees: the apex is 34.64 up and the foot 40 along.
  near(point(assembly, pose, 'right', [0, 0, 0])[2], 40 * Math.sin(Math.PI / 3), 1e-4);
  const foot = point(assembly, pose, 'foot', [0, 0, 0]);
  near(foot[0], 40, 1e-4);
  near(foot[2], 0, 1e-4);
  const lowered = moveJoint(assembly, pose, 'left_pivot', 30);
  assert.equal(lowered.reached, true);
  near(point(assembly, lowered.pose, 'foot', [0, 0, 0])[0], 80 * Math.cos(Math.PI / 6), 1e-4);

  const short = await assemblyOf(`
    part("ground", "a.scad"); part("p", "a.scad"); part("q", "a.scad");
    joint("a", type = "hinge", parent = "ground", child = "p");
    joint("b", type = "hinge", parent = "ground", child = "q", at = [100, 0, 0]);
    joint("c", type = "hinge", parent = "p", child = "q", at = [30, 0, 0], child_at = [30, 0, 0]);
  `);
  const stuck = openingPose(short);
  assert.equal(stuck.closed, false);
  const [state] = loopStates(short, stuck.pose);
  assert.equal(state.joint, 'c');
  near(state.gap, 40, 0.01);
});

test('a part reached through its own child joint is placed from that side', async () => {
  const assembly = await assemblyOf(`
    part("base", "a.scad"); part("arm", "a.scad"); part("tool", "a.scad");
    joint("shoulder", type = "hinge", parent = "base", child = "arm", at = [0, 0, 10], value = 90);
    // Written from the tool's side: the tool is the parent and the arm, already placed, is the child.
    joint("wrist", type = "slider", parent = "tool", child = "arm", at = [0, 5, 0], child_at = [30, 0, 0], axis = [1, 0, 0], limits = [0, 20], value = 8);
  `);
  const shape = structureOf(assembly);
  assert.deepEqual(shape.closures, []);
  assert.deepEqual(shape.roots, [0]);
  const pose = defaultPose(assembly);
  // The arm points along +Y. The joint is 30 along the arm. On the tool it sits at [0, 5, 0], slid 8 along the tool's X.
  const joint = point(assembly, pose, 'arm', [30, 0, 0]);
  near(joint[0], 0);
  near(joint[1], 30);
  near(distance(point(assembly, pose, 'tool', [8, 5, 0]), joint), 0);
  near(settlePose(assembly, pose).pose.wrist, 8);
});

// Following joints: a ratio for gears, a table for a cam or any formula.

/** The value a following joint has in a pose. */
const valueOf = (assembly: AssemblySpec, pose: Pose, name: string) => followerStates(assembly, pose).find((item) => item.joint.name === name)!.value;

test('a following hinge turns by the ratio, and its part is placed by that angle', async () => {
  const assembly = await assemblyOf(`
    part("frame", "a.scad"); part("big", "a.scad"); part("small", "a.scad");
    joint("big", type = "hinge", parent = "frame", child = "big");
    joint("small", type = "hinge", parent = "frame", child = "small", at = [30, 0, 0], follow = "big", ratio = -2);
  `);
  // The follower has no value of its own to set, and the pose does not hold one.
  assert.deepEqual(movingJoints(assembly).map((joint) => joint.name), ['big']);
  assert.deepEqual(Object.keys(defaultPose(assembly)), ['big']);
  for (const [driver, expected] of [[30, -60], [170, -340]]) {
    near(valueOf(assembly, { big: driver }, 'small'), expected);
    const world = solvePose(assembly, { big: driver })[2];
    const wanted = placement([30, 0, 0], [0, 0, expected]);
    world.forEach((entry, i) => near(entry, wanted[i], 1e-9));
  }
  // A value written into the pose for the follower is ignored: the driver decides.
  near(valueOf(assembly, { big: 30, small: 999 }, 'small'), -60);
  const stale = solvePose(assembly, { big: 30, small: 999 })[2];
  solvePose(assembly, { big: 30 })[2].forEach((entry, i) => near(entry, stale[i], 1e-12));
  // Moving the follower directly does nothing.
  const same = { big: 30 };
  assert.equal(moveJoint(assembly, same, 'small', 10).pose, same);
  assert.equal(advanceJoint(assembly, same, 'small', 10).pose, same);
});

test('a table is read by linear interpolation, clamps outside its rows, and takes a ratio and offset', async () => {
  const assembly = await assemblyOf(`
    part("frame", "a.scad"); part("p", "a.scad"); part("q", "a.scad"); part("r", "a.scad");
    joint("drive", type = "slider", parent = "frame", child = "p", limits = [-20, 300]);
    joint("lift", type = "slider", parent = "frame", child = "q", axis = [0, 0, 1],
          follow = "drive", table = [[0, 0], [90, 10], [180, 0]]);
    joint("scaled", type = "slider", parent = "frame", child = "r", axis = [0, 0, 1],
          follow = "drive", ratio = 2, offset = 1, table = [[0, 0], [90, 10], [180, 0]]);
  `);
  near(valueOf(assembly, { drive: 45 }, 'lift'), 5);
  near(valueOf(assembly, { drive: 135 }, 'lift'), 5);
  near(valueOf(assembly, { drive: -10 }, 'lift'), 0);   // below the first row
  near(valueOf(assembly, { drive: 250 }, 'lift'), 0);   // above the last row
  near(valueOf(assembly, { drive: 45 }, 'scaled'), 2 * 5 + 1);
  // The part really is there: 5 mm up the follower's axis.
  near(point(assembly, { drive: 45 }, 'q', [0, 0, 0])[2], 5);
});

test('a full-turn driver is wrapped into a table that spans 360, and a driver with stops is not', async () => {
  const assembly = await assemblyOf(`
    part("frame", "a.scad"); part("wheel", "a.scad"); part("pin", "a.scad");
    joint("wheel", type = "hinge", parent = "frame", child = "wheel");
    joint("pin", type = "slider", parent = "frame", child = "pin", axis = [0, 0, 1],
          follow = "wheel", table = [[0, 0], [180, 10], [360, 0]]);
  `);
  near(valueOf(assembly, { wheel: 90 }, 'pin'), 5);
  near(valueOf(assembly, { wheel: -90 }, 'pin'), 5);                         // looks up 270
  near(valueOf(assembly, { wheel: -170 }, 'pin'), 10 - 10 * (190 - 180) / 180);   // looks up 190

  // The same table behind a hinge that stops at -90 and 90 is clamped to its first row, not wrapped to 270.
  const stopped = await assemblyOf(`
    part("frame", "a.scad"); part("wheel", "a.scad"); part("pin", "a.scad");
    joint("wheel", type = "hinge", parent = "frame", child = "wheel", limits = [-90, 90]);
    joint("pin", type = "slider", parent = "frame", child = "pin", axis = [0, 0, 1],
          follow = "wheel", table = [[0, 0], [180, 10], [360, 0]]);
  `);
  near(valueOf(stopped, { wheel: -90 }, 'pin'), 0);
  near(valueOf(stopped, { wheel: 90 }, 'pin'), 5);
});

test('a table that OpenSCAD computes is followed at its rows and between them', async () => {
  const assembly = await assemblyOf(`
    part("frame", "a.scad"); part("wheel", "a.scad"); part("pin", "a.scad");
    joint("wheel", type = "hinge", parent = "frame", child = "wheel");
    joint("pin", type = "slider", parent = "frame", child = "pin", axis = [0, 0, 1],
          follow = "wheel", table = [for (a = [0 : 5 : 360]) [a, 10 * sin(a)]]);
  `);
  const [pin] = followerStates(assembly, {});
  assert.equal(pin.joint.follow!.table!.length, 73);
  for (const angle of [30, 90, -110]) near(valueOf(assembly, { wheel: angle }, 'pin'), 10 * Math.sin(angle * Math.PI / 180), 1e-3);
  // Halfway between the rows for 45 and 50 degrees.
  near(valueOf(assembly, { wheel: 47.5 }, 'pin'), (10 * Math.sin(Math.PI / 4) + 10 * Math.sin(50 * Math.PI / 180)) / 2, 1e-5);
});

test('followers chain in any order of writing, and a 5,000 row table is read', async () => {
  const assembly = await assemblyOf(`
    part("frame", "a.scad"); part("a", "a.scad"); part("b", "a.scad"); part("c", "a.scad"); part("d", "a.scad");
    joint("a", type = "slider", parent = "frame", child = "a", limits = [0, 100]);
    // c is written before b, which it follows.
    joint("c", type = "slider", parent = "frame", child = "c", follow = "b", ratio = 3, offset = 1);
    joint("b", type = "slider", parent = "frame", child = "b", follow = "a", ratio = 2);
    joint("d", type = "slider", parent = "frame", child = "d", follow = "a", table = [for (x = [0 : 1 : 4999]) [x, x / 100]]);
  `);
  assert.deepEqual(structureOf(assembly).followOrder.map((j) => assembly.joints[j].name), ['b', 'c', 'd']);
  near(valueOf(assembly, { a: 10 }, 'b'), 20);
  near(valueOf(assembly, { a: 10 }, 'c'), 61);
  near(valueOf(assembly, { a: 10 }, 'd'), 0.1);
  assert.equal(followerStates(assembly, {})[2].joint.follow!.table!.length, 5000);
});

test('a speed that cannot work is refused with the joint named and what to change', async () => {
  const bad = async (joints: string, message: RegExp) => assert.rejects(
    builder.build(blocks(`part("frame", "a.scad"); part("p", "a.scad"); part("q", "a.scad"); ${joints}`), 'main.scad'), message);
  const base = 'joint("p", type = "hinge", parent = "frame", child = "p");';
  await bad('joint("p", type = "hinge", parent = "frame", child = "p", speed = 0);', /joint\("p"\): speed must be more than 0: degrees a second for a hinge, millimetres a second for a slider/);
  await bad('joint("p", type = "hinge", parent = "frame", child = "p", speed = -5);', /speed must be more than 0/);
  await bad('joint("p", type = "fixed", parent = "frame", child = "p", speed = 20);', /joint\("p"\): a fixed joint does not move\. Remove speed or change the type/);
  await bad(`${base} joint("q", type = "hinge", parent = "frame", child = "q", follow = "p", speed = 20);`, /joint\("q"\): a joint that follows another moves with it and has no Play speed of its own\. Remove speed/);
  await bad('joint("p", type = "hinge", parent = "frame", child = "p", speed = "fast");', /joint\("p"\): speed must be a number/);
});

test('a follower that cannot work is refused with the joint named and what to change', async () => {
  const bad = async (joints: string, message: RegExp) => assert.rejects(
    builder.build(blocks(`part("frame", "a.scad"); part("p", "a.scad"); part("q", "a.scad"); ${joints}`), 'main.scad'), message);
  const base = 'joint("p", type = "hinge", parent = "frame", child = "p");';
  await bad('joint("a", type = "hinge", parent = "frame", child = "p", follow = "b"); joint("b", type = "hinge", parent = "frame", child = "q", follow = "a");',
    /joint\("a"\): the follow links go in a circle \(a → b → a\)/);
  await bad(`${base} joint("q", type = "hinge", parent = "frame", child = "q", follow = "q");`, /joint\("q"\): a joint cannot follow itself/);
  await bad(`${base} joint("q", type = "hinge", parent = "frame", child = "q", follow = "ghost");`, /joint\("q"\): follows "ghost", which is not a joint/);
  await bad(`${base} joint("q", type = "hinge", parent = "frame", child = "q", follow = "p", limits = [0, 90]);`, /joint\("q"\): a joint that follows another takes its value from it\. Remove limits and value/);
  await bad(`${base} joint("q", type = "hinge", parent = "frame", child = "q", follow = "p", value = 10);`, /Remove limits and value/);
  await bad(`${base} joint("q", type = "fixed", parent = "frame", child = "q", follow = "p");`, /a fixed joint does not move, so it cannot follow/);
  await bad('joint("p", type = "fixed", parent = "frame", child = "p"); joint("q", type = "hinge", parent = "frame", child = "q", follow = "p");', /follows "p", which is a fixed joint/);
  await bad(`${base} joint("q", type = "hinge", parent = "frame", child = "q", ratio = 2);`, /joint\("q"\): ratio, offset and table only work with follow/);
  await bad(`${base} joint("q", type = "slider", parent = "frame", child = "q", follow = "p", table = [[0, 1]]);`, /table needs at least two rows/);
  await bad(`${base} joint("q", type = "slider", parent = "frame", child = "q", follow = "p", table = [[0, 1], [60, 2], [30, 3]]);`,
    /table inputs must increase, but row 3 \(30\) does not come after row 2 \(60\)/);
  await bad(`${base} joint("q", type = "slider", parent = "frame", child = "q", follow = "p", table = [[0, 1], [60]]);`, /table row 2 must be \[input, output\]/);
  await bad(`${base} joint("q", type = "slider", parent = "frame", child = "q", follow = "p", table = [for (x = [0 : 5000]) [x, x]]);`, /table has 5001 rows\. Use at most 5,000/);
});

test('a joint on a loop cannot follow, but a joint outside the loop can follow one on it', async () => {
  const files = (edit: (source: string) => string) => ({ ...crankRocker, 'four_bar.scad': edit(crankRocker['four_bar.scad']) });
  await assert.rejects(builder.build(files((source) => source.replace('joint("crank_pin", type = "hinge",', 'joint("crank_pin", type = "hinge", follow = "crank",')), 'four_bar.scad'),
    /joint\("crank_pin"\) follows another joint, so it cannot be part of a closed loop/);
  await assert.rejects(builder.build(files((source) => source.replace('joint("rocker_pin", type = "hinge",', 'joint("rocker_pin", type = "hinge", follow = "crank",')), 'four_bar.scad'),
    /joint\("rocker_pin"\) follows another joint, so it cannot be part of a closed loop/);
  await assert.rejects(builder.build(files((source) => `${source}\npart("extra", "ground.scad");\njoint("extra", type = "hinge", parent = "ground", child = "extra", follow = "rocker_pin");`), 'four_bar.scad'),
    /follows "rocker_pin", which closes a loop and has no value of its own/);
});

test('a wheel that follows the crank of a closed linkage stays at minus two cranks through a full turn', async () => {
  const model = await builder.build({
    ...crankRocker,
    'wheel.scad': 'cylinder(r = 10, h = 3);',
    'four_bar.scad': `${crankRocker['four_bar.scad']}
      part("wheel", "wheel.scad");
      joint("wheel", type = "hinge", parent = "ground", child = "wheel", at = [0, -30, 0], follow = "crank", ratio = -2);`,
  }, 'four_bar.scad');
  const { assembly } = model.preview;
  assert.deepEqual(movingJoints(assembly).map((joint) => joint.name), ['crank', 'crank_pin', 'rocker']);
  let { pose, closed } = openingPose(assembly);
  assert.equal(closed, true);
  near(pose.rocker, 71.1, 0.1);   // the follower does not change how the loop assembles
  for (let i = 0; i < 72; i++) {
    const moved = advanceJoint(assembly, pose, 'crank', 5);
    assert.equal(moved.reached, true, `crank stuck at step ${i}`);
    pose = moved.pose;
    assert.equal(loopStates(assembly, pose)[0].closed, true);
    // A point 10 mm along the wheel's x axis, with the wheel turned by minus twice the crank angle.
    const turn = -2 * pose.crank * Math.PI / 180;
    const tip = point(assembly, pose, 'wheel', [10, 0, 0]);
    near(tip[0], 10 * Math.cos(turn), 1e-9);
    near(tip[1], -30 + 10 * Math.sin(turn), 1e-9);
  }
  near(pose.crank, 40, 1e-6);
});

test('the geared example follows its formulas, and its STEP holds each part where they put it', async () => {
  const model = await builder.build(gearedMechanism, 'geared.scad');
  const { assembly } = model.preview;
  assert.deepEqual(model.preview.partMesh.map((i) => model.preview.meshes[i].quality), ['exact', 'exact', 'exact', 'exact']);
  assert.deepEqual(movingJoints(assembly).map((joint) => joint.name), ['crank']);
  // Wheel angle is minus twice the crank angle. The plunger lifts 6 (1 - cos) mm for that angle, from rows 5 degrees apart.
  for (const crank of [0, 30, 45, 90, 135, 180, -60, -150]) {
    const wheel = -2 * crank;
    near(valueOf(assembly, { crank }, 'wheel'), wheel, 1e-9);
    near(valueOf(assembly, { crank }, 'plunger'), 6 * (1 - Math.cos(wheel * Math.PI / 180)), 2e-3);
  }

  for (const [crank, lift] of [[30, 3], [90, 12]]) {
    const step = new TextDecoder().decode(builder.exportStep(model, { crank }));
    await writeFile(new URL(`geared_${crank}.step`, output), step);
    const solids = kernel.getSubShapes(kernel.importStep(step), 'solid');
    assert.equal(solids.length, 4);
    // The plunger is the only solid of volume pi r^2 h = pi * 2.5^2 * 24. It starts on the frame top at z = 6 and is lifted.
    const plunger = solids.find((solid) => Math.abs(kernel.getVolume(solid) - Math.PI * 2.5 ** 2 * 24) < 0.01)!;
    const box = kernel.getBoundingBox(plunger);
    near(box.zmin, 6 + lift, 1e-3);
    near(box.zmax, 6 + lift + 24, 1e-3);
    near(box.xmin, 79.5, 1e-6);
  }
});

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { defaultPose, movingJoints, poseBounds, solvePose, structureOf, type AssemblySpec } from '../src/engine/assembly.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import { advanceJoint, loopStates, moveJoint, openingPose, settlePose } from '../src/engine/kinematics.ts';
import type { Pose } from '../src/engine/protocol.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
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

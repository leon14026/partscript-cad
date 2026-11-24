import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { ModelBuilder } from '../src/engine/build.ts';
import { advanceJoint, playSpeed, playStep } from '../src/engine/kinematics.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

function near(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

// A hinge with stops (0 to 90), a slider of 100 mm, and a hinge that turns all the way round.
const { assembly } = (
  await builder.build({
    'main.scad': `
      part("base") cube([10, 10, 2]);
      part("arm") cube([4, 4, 4]);
      part("carriage") cube([4, 4, 4]);
      part("wheel") cube([4, 4, 4]);
      joint("swing", type = "hinge", parent = "base", child = "arm", limits = [0, 90]);
      joint("slide", type = "slider", parent = "base", child = "carriage", axis = [1, 0, 0], limits = [0, 100]);
      joint("spin", type = "hinge", parent = "base", child = "wheel");
      part("slow") cube([4, 4, 4]);
      part("belt") cube([4, 4, 4]);
      joint("slow", type = "hinge", parent = "base", child = "slow", limits = [0, 90], speed = 30);
      joint("belt", type = "slider", parent = "base", child = "belt", axis = [0, 1, 0], limits = [0, 100], speed = 10);
    `,
  }, 'main.scad')
).preview;

test('Play moves a hinge 110 degrees a second and a slider across its travel in 2.5 seconds', () => {
  near(playSpeed(assembly, 'swing'), 110);
  near(playSpeed(assembly, 'spin'), 110);
  near(playSpeed(assembly, 'slide'), 100 / 2.5);
  // 0.4 s of a hinge is 44 degrees, and 0.5 s of the slider is 20 mm.
  near(playStep(assembly, {}, 'swing', 1, 0.4).pose.swing, 44);
  near(playStep(assembly, {}, 'slide', 1, 0.5).pose.slide, 20);
});

test('a joint with a speed of its own plays at that speed, and the others keep the default', () => {
  near(playSpeed(assembly, 'slow'), 30);
  near(playSpeed(assembly, 'belt'), 10);
  near(playSpeed(assembly, 'swing'), 110);
  // 0.4 s of a hinge at 30 degrees a second is 12 degrees, and 0.5 s of a slider at 10 mm a second is 5 mm.
  near(playStep(assembly, {}, 'slow', 1, 0.4).pose.slow, 12);
  near(playStep(assembly, {}, 'belt', 1, 0.5).pose.belt, 5);
  // The speed sets the pace and not the stops: from 80 degrees, 1 s at 30 degrees a second asks for 110 and stops at 90.
  const stop = playStep(assembly, { slow: 80 }, 'slow', 1, 1);
  near(stop.pose.slow, 90);
  assert.equal(stop.direction, -1);
});

test('a joint with stops turns round at the end of its travel', () => {
  // From 80 degrees, 0.2 s asks for 102. The hinge stops at 90 and goes back from there.
  const up = playStep(assembly, { swing: 80 }, 'swing', 1, 0.2);
  near(up.pose.swing, 90);
  assert.equal(up.direction, -1);
  // From 10 degrees going down, 0.2 s asks for -12. It stops at 0 and goes up.
  const down = playStep(assembly, { swing: 10 }, 'swing', -1, 0.2);
  near(down.pose.swing, 0);
  assert.equal(down.direction, 1);
  // The slider does the same at 100 mm: from 90, 0.5 s asks for 110.
  const far = playStep(assembly, { slide: 90 }, 'slide', 1, 0.5);
  near(far.pose.slide, 100);
  assert.equal(far.direction, -1);
  // In the middle of the travel the direction stays.
  assert.equal(playStep(assembly, { swing: 40 }, 'swing', -1, 0.1).direction, -1);
});

test('a hinge without stops keeps turning past 180 degrees', () => {
  // From 170, 0.2 s is 22 degrees: 192, which is the same position as -168.
  const turned = playStep(assembly, { spin: 170 }, 'spin', 1, 0.2);
  near(turned.pose.spin, -168);
  assert.equal(turned.direction, 1);
});

test('several joints play at once by moving one after another, each from the pose the one before left', () => {
  // The same 0.4 s frame for all three joints, as the preview does it.
  let pose = { swing: 20, slide: 10, spin: 0 };
  let directions: Record<string, 1 | -1> = { swing: 1, slide: -1, spin: 1 };
  for (const name of ['swing', 'slide', 'spin']) {
    const step = playStep(assembly, pose, name, directions[name], 0.4);
    pose = step.pose as typeof pose;
    directions = { ...directions, [name]: step.direction };
  }
  near(pose.swing, 20 + 44);            // 110 x 0.4 up
  near(pose.slide, 0);                  // 40 x 0.4 = 16 down from 10 asks for -6, so it stops at 0
  assert.equal(directions.slide, 1);    // and turns round
  near(pose.spin, 44);
  // Playing one joint does not disturb another one's value.
  near(advanceJoint(assembly, pose, 'swing', 10).pose.slide, 0);
});

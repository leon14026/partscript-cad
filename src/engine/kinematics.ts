import { clampJoint, defaultPose, jointValues, multiply, placeParts, structureOf, turnsFully, type AssemblySpec, type Matrix } from './assembly.ts';
import type { Pose } from './protocol.ts';

/**
 * Closed loops. A four-bar linkage has four hinges in a ring, so three of
 * them carry parts and the fourth closes the ring. Turning one hinge forces
 * the others to follow. This file finds the values of the other joints that
 * keep every closing joint shut, by least squares from the current pose, so
 * the mechanism stays on the branch it is on.
 */

/** A loop counts as shut when every error is below this, in mm. An angle error is scaled to mm by the mechanism's size. */
const tolerance = 1e-5;
const maxIterations = 60;

export interface LoopState {
  /** Name of the closing joint. */
  joint: string;
  /** Distance left between the two halves of the closing joint, in mm. */
  gap: number;
  closed: boolean;
}

/** Errors of every closing joint: zero when all loops are shut. */
function residuals(assembly: AssemblySpec, values: number[], perJoint?: number[][]) {
  const { closures, frames, scale } = structureOf(assembly);
  const index = new Map(assembly.parts.map((part, i) => [part.name, i]));
  const world = placeParts(assembly, values);
  const out: number[] = [];
  for (const j of closures) {
    const joint = assembly.joints[j];
    const a: Matrix = multiply(world[index.get(joint.parent)!], frames[j].parent);
    const b: Matrix = multiply(world[index.get(joint.child)!], frames[j].child);
    const start = out.length;
    const offset = [b[3] - a[3], b[7] - a[7], b[11] - a[11]];
    const axisIn = (m: Matrix) => [0, 1, 2].map((row) => m[row * 4] * joint.axis[0] + m[row * 4 + 1] * joint.axis[1] + m[row * 4 + 2] * joint.axis[2]);
    if (joint.type === 'hinge') {
      // The pin centres meet and the two halves agree on the pin's direction.
      const [pa, pb] = [axisIn(a), axisIn(b)];
      out.push(...offset, ...pa.map((v, i) => (pb[i] - v) * scale));
    } else {
      // Slider and fixed: the two halves have the same orientation.
      for (const column of [0, 1]) for (const row of [0, 1, 2]) out.push((b[row * 4 + column] - a[row * 4 + column]) * scale);
      if (joint.type === 'slider') {
        // Only travel along the axis is allowed.
        const along = axisIn(a);
        const travel = offset[0] * along[0] + offset[1] * along[1] + offset[2] * along[2];
        out.push(...offset.map((v, i) => v - travel * along[i]));
      } else {
        out.push(...offset);
      }
    }
    perJoint?.push(out.slice(start));
  }
  return out;
}

function largest(values: number[]) {
  let result = 0;
  for (const value of values) result = Math.max(result, Math.abs(value));
  return result;
}

/** Solve a small dense system by elimination with pivoting. Returns undefined when it is singular. */
function solveLinear(a: number[][], b: number[]) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-300) return undefined;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / a[col][col];
      if (!factor) continue;
      for (let k = col; k < n; k++) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Array<number>(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * x[k];
    x[row] = sum / a[row][row];
  }
  return x;
}

/** Adjust the free joints until every loop is shut. Levenberg-Marquardt with a numeric Jacobian. */
function close(assembly: AssemblySpec, start: number[], free: number[]) {
  const { joints } = assembly;
  const values = [...start];
  let r = residuals(assembly, values);
  if (!free.length || !r.length) return { ok: largest(r) < tolerance, values };
  const bound = (j: number, value: number) => (turnsFully(joints[j]) ? value : Math.min(joints[j].limits[1], Math.max(joints[j].limits[0], value)));
  let cost = r.reduce((sum, v) => sum + v * v, 0);
  let damping = 1e-3;

  for (let iteration = 0; iteration < maxIterations && largest(r) >= tolerance; iteration++) {
    const step = 1e-4;
    const columns = free.map((j) => {
      const keep = values[j];
      values[j] = keep + step;
      const plus = residuals(assembly, values);
      values[j] = keep - step;
      const minus = residuals(assembly, values);
      values[j] = keep;
      return plus.map((v, i) => (v - minus[i]) / (2 * step));
    });
    const n = free.length;
    const normal = columns.map((ci) => columns.map((cj) => ci.reduce((sum, v, i) => sum + v * cj[i], 0)));
    const gradient = columns.map((c) => c.reduce((sum, v, i) => sum + v * r[i], 0));

    let improved = false;
    for (let attempt = 0; attempt < 12 && !improved; attempt++) {
      const a = normal.map((row, i) => row.map((v, k) => (i === k ? v + damping * (v + 1e-9) : v)));
      const delta = solveLinear(a, gradient.map((g) => -g));
      if (delta) {
        const trial = [...values];
        for (let k = 0; k < n; k++) trial[free[k]] = bound(free[k], values[free[k]] + delta[k]);
        const next = residuals(assembly, trial);
        const nextCost = next.reduce((sum, v) => sum + v * v, 0);
        if (nextCost < cost) {
          for (const j of free) values[j] = trial[j];
          r = next;
          cost = nextCost;
          damping = Math.max(damping / 5, 1e-10);
          improved = true;
          continue;
        }
      }
      damping *= 8;
    }
    if (!improved) break;
  }
  return { ok: largest(r) < tolerance, values };
}

/**
 * Shut the loops from a starting guess that may be poor. A guess with every
 * link in one line is balanced on a knife edge and gives the search no
 * direction, so nudged copies of the guess are tried as well. Returns the
 * closed result, or the nearest one found.
 */
function closeFrom(assembly: AssemblySpec, start: number[], free: number[]) {
  const { joints } = assembly;
  const { scale } = structureOf(assembly);
  let best = close(assembly, start, free);
  if (best.ok || !free.length) return best;
  let bestError = largest(residuals(assembly, best.values));
  const signs = [() => 1, () => -1, (k: number) => (k % 2 ? -1 : 1), (k: number) => (k % 2 ? 1 : -1)];
  for (const sign of signs) {
    const nudged = [...start];
    free.forEach((j, k) => {
      const amount = joints[j].type === 'hinge' ? 17 : Math.min(scale, joints[j].limits[1] - joints[j].limits[0]) / 7;
      nudged[j] = turnsFully(joints[j]) ? start[j] + sign(k) * amount
        : Math.min(joints[j].limits[1], Math.max(joints[j].limits[0], start[j] + sign(k) * amount));
    });
    const result = close(assembly, nudged, free);
    if (result.ok) return result;
    const error = largest(residuals(assembly, result.values));
    if (error < bestError) {
      best = result;
      bestError = error;
    }
  }
  return best;
}

function toPose(assembly: AssemblySpec, values: number[], base: Pose): Pose {
  const { closures } = structureOf(assembly);
  const pose = { ...base };
  assembly.joints.forEach((joint, j) => {
    // A following joint has no value in the pose: it is worked out from its driver wherever parts are placed.
    if (joint.type !== 'fixed' && !joint.follow && !closures.includes(j)) pose[joint.name] = clampJoint(joint, values[j]);
  });
  return pose;
}

function loopJoints(assembly: AssemblySpec, except: number[] = []) {
  const { looped } = structureOf(assembly);
  return assembly.joints.flatMap((joint, j) => (looped[j] && joint.type !== 'fixed' && !joint.follow && !except.includes(j) ? [j] : []));
}

export function hasLoops(assembly: AssemblySpec) {
  return structureOf(assembly).closures.length > 0;
}

/** For each closing joint, how far its two halves are apart in this pose. */
export function loopStates(assembly: AssemblySpec, pose: Pose): LoopState[] {
  const { closures } = structureOf(assembly);
  if (!closures.length) return [];
  const perJoint: number[][] = [];
  residuals(assembly, jointValues(assembly, pose), perJoint);
  return closures.map((j, i) => {
    const r = perJoint[i];
    // The last three numbers of each closing joint's errors are its position error.
    const gap = assembly.joints[j].type === 'hinge' ? Math.hypot(r[0], r[1], r[2]) : Math.hypot(...r.slice(-3));
    return { joint: assembly.joints[j].name, gap, closed: largest(r) < tolerance * 10 };
  });
}

/**
 * Shut the loops of a pose that came from the code or from an earlier build.
 * Joints the pose should keep are tried in turn: all `hold` joints, then the
 * first of them, then none.
 */
export function settlePose(assembly: AssemblySpec, pose: Pose, hold: string[] = []): { pose: Pose; closed: boolean } {
  if (!hasLoops(assembly)) return { pose, closed: true };
  const start = jointValues(assembly, pose);
  const held = hold.map((name) => assembly.joints.findIndex((joint) => joint.name === name)).filter((j) => j >= 0);
  const attempts = [held, held.slice(0, 1), []].filter((list, i, all) => i === 0 || list.length < all[i - 1].length);
  for (const fixed of attempts) {
    const result = closeFrom(assembly, start, loopJoints(assembly, fixed));
    if (result.ok) return { pose: toPose(assembly, result.values, pose), closed: true };
  }
  // Show the nearest pose so the gap is visible.
  return { pose: toPose(assembly, closeFrom(assembly, start, loopJoints(assembly)).values, pose), closed: false };
}

/** The pose the code asks for, with its loops shut. */
export function openingPose(assembly: AssemblySpec) {
  const { looped } = structureOf(assembly);
  const given = assembly.joints.filter((joint, j) => looped[j] && joint.given).map((joint) => joint.name);
  return settlePose(assembly, defaultPose(assembly), given);
}

/**
 * Move one joint toward a value. In a loop the other joints follow. The move
 * is made in small steps so the mechanism stays on its branch, and it stops
 * where the loop can no longer stay shut: at a dead point or an end stop.
 */
export function moveJoint(assembly: AssemblySpec, pose: Pose, name: string, target: number): { pose: Pose; reached: boolean } {
  const j = assembly.joints.findIndex((joint) => joint.name === name);
  const joint = assembly.joints[j];
  // A following joint is moved by moving the joint it follows.
  if (!joint || joint.type === 'fixed' || joint.follow) return { pose, reached: false };
  const { looped, closures } = structureOf(assembly);
  if (closures.includes(j)) return { pose, reached: false };
  const goal = Math.min(joint.limits[1], Math.max(joint.limits[0], target));
  if (!looped[j]) return { pose: { ...pose, [name]: goal }, reached: goal === target };

  const free = loopJoints(assembly, [j]);
  let values = jointValues(assembly, pose);
  if (!close(assembly, values, []).ok) {
    // The pose handed in is open. Shut it first, keeping this joint where it is if possible.
    const settled = settlePose(assembly, pose, [name]);
    if (!settled.closed) return { pose: settled.pose, reached: false };
    values = jointValues(assembly, settled.pose);
  }
  const stride = joint.type === 'hinge' ? 3 : Math.max((joint.limits[1] - joint.limits[0]) / 60, 1e-3);
  let step = stride;
  while (Math.abs(goal - values[j]) > 1e-9 && step > stride / 64) {
    const trial = [...values];
    trial[j] = values[j] + Math.max(-step, Math.min(step, goal - values[j]));
    const result = close(assembly, trial, free);
    if (result.ok) {
      values = result.values;
      step = Math.min(stride, step * 2);
    } else {
      step /= 2;
    }
  }
  return { pose: toPose(assembly, values, pose), reached: Math.abs(goal - values[j]) <= 1e-9 };
}

/**
 * Move a joint by an amount, for animation. A hinge with no end stops keeps
 * turning past its last value and continues from its first.
 */
export function advanceJoint(assembly: AssemblySpec, pose: Pose, name: string, amount: number): { pose: Pose; reached: boolean } {
  const joint = assembly.joints.find((item) => item.name === name);
  if (!joint || joint.follow) return { pose, reached: false };
  const [low, high] = joint.limits;
  let current = clampJoint(joint, pose[name]);
  let remaining = amount;
  let result = { pose, reached: true };
  for (let guard = 0; guard < 4 && remaining !== 0 && result.reached; guard++) {
    const target = current + remaining;
    if (turnsFully(joint) && (target > high || target < low)) {
      const edge = target > high ? high : low;
      result = moveJoint(assembly, result.pose, name, edge);
      if (!result.reached) break;
      remaining = target - edge;
      // One full turn on, the mechanism is in the same position.
      current = edge === high ? high - 360 : low + 360;
      result = { pose: { ...result.pose, [name]: current }, reached: true };
    } else {
      result = moveJoint(assembly, result.pose, name, target);
      remaining = 0;
    }
  }
  return result;
}

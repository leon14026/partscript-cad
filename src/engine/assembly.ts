import { CadError, type Pose, type Vec3 } from './protocol.ts';

/**
 * Assemblies are written in OpenSCAD. The two modules below are appended to
 * every file before it is evaluated. They draw nothing. Each call prints one
 * record, which the worker reads back from the OpenSCAD console.
 *
 * OpenSCAD prints numbers with six significant digits. A number is therefore
 * sent as [whole part, millionths] so positions keep 0.000001 mm.
 */
export const assemblyPrelude = `
function _ps_n(x) = is_num(x) ? [floor(x), round((x - floor(x)) * 1000000)] : x;
function _ps_v(v) = is_list(v) ? [for (x = v) _ps_n(x)] : v;
function _ps_hash(s, i = 0, a = 7) = i >= len(s) ? a : _ps_hash(s, i + 1, (a * 31 + ord(s[i])) % 99991);
module part(name = undef, file = undef, at = [0, 0, 0], rot = [0, 0, 0], color = undef) {
    echo(["@partscript", "part", name, file, _ps_v(at), _ps_v(rot), _ps_v(color), $children]);
    if ($children > 0) render(convexity = 900000 + _ps_hash(is_string(name) ? name : "")) children();
}
module joint(name = undef, type = "fixed", parent = undef, child = undef, at = [0, 0, 0], rot = [0, 0, 0], axis = [0, 0, 1], limits = undef, value = undef, child_at = [0, 0, 0], child_rot = [0, 0, 0]) {
    echo(["@partscript", "joint", name, type, parent, child, _ps_v(at), _ps_v(rot), _ps_v(axis), _ps_v(limits), _ps_n(value), _ps_v(child_at), _ps_v(child_rot)]);
}
`;

export const recordMarker = '["@partscript"';

/**
 * The number part() puts in the convexity of the render node around an inline
 * part's shapes. It is 900000 plus a hash of the name, so the shapes can be
 * found in OpenSCAD's output and matched to their part(). Keep it in step with
 * _ps_hash in the prelude above.
 */
export function partTag(name: string): number {
  let hash = 7;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) % 99991;
  return 900_000 + hash;
}

export type JointType = 'fixed' | 'hinge' | 'slider';
export type Color = [number, number, number];
/** 3x4 row-major rigid transform: [r00,r01,r02,tx, r10,r11,r12,ty, r20,r21,r22,tz]. */
export type Matrix = number[];

export interface PartSpec {
  name: string;
  /** The part file. Undefined for an inline part, whose shapes are written in braces after part(). */
  file?: string;
  /** True when the shapes are written in braces in the assembly file. */
  inline: boolean;
  /** Placement of a part that no joint carries. */
  at: Vec3;
  rot: Vec3;
  color: Color;
  /** True when part() was given a color. Otherwise the first color() in the shapes is used, if there is one. */
  colorGiven: boolean;
}

export interface JointSpec {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** Joint frame in the parent part's coordinates. */
  at: Vec3;
  rot: Vec3;
  /** The same joint frame in the child part's coordinates. The child's origin by default. */
  childAt: Vec3;
  childRot: Vec3;
  /** Motion axis in the joint frame. Unit length. */
  axis: Vec3;
  /** Travel limits: degrees for a hinge, millimetres for a slider. */
  limits: [number, number];
  /** Value the model opens with. */
  value: number;
  /** True when the code set value. In a loop the first such joint is held and the others are starting guesses. */
  given: boolean;
}

export interface AssemblySpec {
  parts: PartSpec[];
  joints: JointSpec[];
}

const maxParts = 200;
const maxCoordinate = 1_000_000;
const namePattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const fileNamePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}\.scad$/;

// Muted tones that stay readable against the dark viewport.
export const palette: Color[] = [
  [0.784, 0.616, 0.349], [0.467, 0.612, 0.729], [0.596, 0.694, 0.467], [0.741, 0.486, 0.42],
  [0.647, 0.561, 0.741], [0.427, 0.659, 0.627], [0.78, 0.71, 0.48], [0.69, 0.7, 0.71],
];

type Value = number | boolean | string | null | Value[];

/** Read one value in the notation OpenSCAD's echo() prints. */
function parseEcho(text: string): Value {
  let offset = 0;
  function space() {
    while (text[offset] === ' ') offset++;
  }
  function value(depth: number): Value {
    space();
    if (depth > 6) throw new Error('nesting');
    if (text[offset] === '[') {
      offset++;
      const items: Value[] = [];
      space();
      if (text[offset] === ']') {
        offset++;
        return items;
      }
      while (true) {
        items.push(value(depth + 1));
        space();
        if (text[offset] === ',') offset++;
        else if (text[offset] === ']') {
          offset++;
          return items;
        } else throw new Error('list');
      }
    }
    if (text[offset] === '"') {
      let result = '';
      offset++;
      while (offset < text.length && text[offset] !== '"') {
        if (text[offset] === '\\') offset++;
        result += text[offset++];
      }
      if (text[offset] !== '"') throw new Error('string');
      offset++;
      return result;
    }
    const word = /^[A-Za-z0-9_.+-]+/.exec(text.slice(offset))?.[0];
    if (!word) throw new Error('token');
    offset += word.length;
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'undef') return null;
    if (word === 'nan' || word === '-nan') return NaN;
    if (word === 'inf') return Infinity;
    if (word === '-inf') return -Infinity;
    const number = Number(word);
    if (Number.isNaN(number)) throw new Error('number');
    return number;
  }
  const result = value(0);
  space();
  if (offset !== text.length) throw new Error('trailing');
  return result;
}

function fail(what: string, message: string): never {
  throw new CadError(`${what}: ${message}`);
}

function text(value: Value, what: string, label: string) {
  if (typeof value !== 'string' || !value) fail(what, `give it a ${label} in quotes.`);
  return value;
}

function number(value: Value, what: string, label: string) {
  const valid = Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'number');
  if (!valid) fail(what, `${label} must be a number.`);
  const [whole, millionths] = value as number[];
  const result = whole + millionths / 1_000_000;
  if (!Number.isFinite(result) || Math.abs(result) > maxCoordinate) fail(what, `${label} must be a finite number within ±1,000,000.`);
  return result;
}

function vector(value: Value, what: string, label: string, size = 3) {
  if (!Array.isArray(value) || value.length !== size) fail(what, `${label} must be a list of ${size} numbers.`);
  return value.map((item, i) => number(item, what, `${label}[${i}]`));
}

function color(value: Value, what: string, index: number): Color {
  if (value === null) return palette[index % palette.length];
  if (typeof value === 'string') {
    const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
    if (!hex) fail(what, 'color must be [r, g, b] with values from 0 to 1, or a string such as "#c89d59".');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Color;
  }
  const rgb = vector(value, what, 'color');
  if (rgb.some((channel) => channel < 0 || channel > 1)) fail(what, 'color values must be from 0 to 1.');
  return rgb as Color;
}

/** Turn the records printed by part() and joint() into a checked assembly. */
export function readAssembly(records: string[]): AssemblySpec {
  const parts: PartSpec[] = [];
  const joints: JointSpec[] = [];
  const placed = new Set<string>();

  for (const record of records) {
    let fields: Value;
    try {
      fields = parseEcho(record);
    } catch {
      throw new CadError('A part() or joint() call has a value the assembly reader cannot use. Use plain names without quotes or line breaks inside them.');
    }
    if (!Array.isArray(fields)) continue;
    if (fields[1] === 'part') {
      const what = typeof fields[2] === 'string' && fields[2] ? `part("${fields[2]}")` : `part() number ${parts.length + 1}`;
      const name = text(fields[2], what, 'name');
      if (!namePattern.test(name)) fail(what, 'names use letters, digits, _ . and -, and start with a letter.');
      if (parts.some((item) => item.name === name)) fail(what, 'this name is used twice. Give every part its own name.');
      const children = typeof fields[7] === 'number' ? fields[7] : 0;
      let file: string | undefined;
      if (fields[3] === null) {
        if (!children) fail(what, 'give it a file name or shapes in braces.');
      } else {
        if (children) fail(what, 'it has both a file and shapes in braces. Use one.');
        file = text(fields[3], what, 'file name');
        if (!fileNamePattern.test(file)) fail(what, `"${file}" is not a project file name. Use a name such as "arm.scad".`);
      }
      const at = vector(fields[4], what, 'at') as Vec3;
      const rot = vector(fields[5], what, 'rot') as Vec3;
      if (at.some((v) => v !== 0) || rot.some((v) => v !== 0)) placed.add(name);
      parts.push({ name, file, inline: file === undefined, at, rot, color: color(fields[6], what, parts.length), colorGiven: fields[6] !== null });
      if (parts.length > maxParts) throw new CadError(`An assembly can hold ${maxParts} parts.`);
    } else if (fields[1] === 'joint') {
      const what = typeof fields[2] === 'string' && fields[2] ? `joint("${fields[2]}")` : `joint() number ${joints.length + 1}`;
      const name = text(fields[2], what, 'name');
      if (!namePattern.test(name)) fail(what, 'names use letters, digits, _ . and -, and start with a letter.');
      if (joints.some((item) => item.name === name)) fail(what, 'this name is used twice. Give every joint its own name.');
      const type = fields[3];
      if (type !== 'fixed' && type !== 'hinge' && type !== 'slider') fail(what, 'type must be "fixed", "hinge" or "slider".');
      const parent = text(fields[4], what, 'parent part name');
      const child = text(fields[5], what, 'child part name');
      const at = vector(fields[6], what, 'at') as Vec3;
      const rot = vector(fields[7], what, 'rot') as Vec3;
      const rawAxis = vector(fields[8], what, 'axis');
      const norm = Math.hypot(...rawAxis);
      if (norm < 1e-9) fail(what, 'axis needs a direction such as [0, 0, 1].');
      const axis = rawAxis.map((v) => v / norm) as Vec3;
      const childAt = vector(fields[11], what, 'child_at') as Vec3;
      const childRot = vector(fields[12], what, 'child_rot') as Vec3;

      let limits: [number, number] = type === 'hinge' ? [-180, 180] : [0, 0];
      if (fields[9] !== null) {
        if (type === 'fixed') fail(what, 'a fixed joint does not move. Remove limits or change the type.');
        limits = vector(fields[9], what, 'limits', 2) as [number, number];
        if (limits[0] > limits[1]) fail(what, 'limits must be [lowest, highest].');
      } else if (type === 'slider') {
        fail(what, 'a slider needs limits in millimetres, for example limits = [0, 40].');
      }
      let value = Math.min(Math.max(0, limits[0]), limits[1]);
      if (fields[10] !== null) {
        if (type === 'fixed') fail(what, 'a fixed joint does not move. Remove value or change the type.');
        value = number(fields[10], what, 'value');
        if (value < limits[0] - 1e-9 || value > limits[1] + 1e-9) fail(what, `value ${value} is outside limits [${limits[0]}, ${limits[1]}].`);
      }
      joints.push({ name, type, parent, child, at, rot, childAt, childRot, axis, limits, value, given: fields[10] !== null });
    }
  }

  if (!parts.length) throw new CadError('The assembly has joints and no parts. Add part("name", "file.scad") or part("name") { shapes } for each part.');
  const names = new Set(parts.map((item) => item.name));
  for (const item of joints) {
    const what = `joint("${item.name}")`;
    if (!names.has(item.parent)) fail(what, `parent "${item.parent}" is not a part. Declare it with part().`);
    if (!names.has(item.child)) fail(what, `child "${item.child}" is not a part. Declare it with part().`);
    if (item.parent === item.child) fail(what, 'parent and child must be different parts.');
  }
  const assembly = { parts, joints };
  const { carrier } = structureOf(assembly);
  parts.forEach((part, i) => {
    if (carrier[i] >= 0 && placed.has(part.name)) {
      fail(`joint("${joints[carrier[i]].name}")`, `"${part.name}" also has at or rot on its part() line. Place it with the joint's at and rot.`);
    }
  });
  return assembly;
}

/** A single part file is shown and exported as an assembly of one part. */
export function singlePart(file: string): AssemblySpec {
  return { parts: [{ name: file.replace(/\.scad$/i, ''), file, inline: false, at: [0, 0, 0], rot: [0, 0, 0], color: palette[0], colorGiven: false }], joints: [] };
}

export const identity: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function multiply(a: Matrix, b: Matrix): Matrix {
  const result = new Array<number>(12);
  for (let row = 0; row < 3; row++) {
    const [x, y, z, t] = [a[row * 4], a[row * 4 + 1], a[row * 4 + 2], a[row * 4 + 3]];
    result[row * 4] = x * b[0] + y * b[4] + z * b[8];
    result[row * 4 + 1] = x * b[1] + y * b[5] + z * b[9];
    result[row * 4 + 2] = x * b[2] + y * b[6] + z * b[10];
    result[row * 4 + 3] = x * b[3] + y * b[7] + z * b[11] + t;
  }
  return result;
}

/** Rotation about a unit axis through the origin. */
export function axisRotation([x, y, z]: Vec3, degrees: number): Matrix {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0];
}

/** Same order as OpenSCAD: translate(at) rotate([x, y, z]), which turns about X, then Y, then Z. */
export function placement(at: Vec3, rot: Vec3): Matrix {
  const turn = multiply(axisRotation([0, 0, 1], rot[2]), multiply(axisRotation([0, 1, 0], rot[1]), axisRotation([1, 0, 0], rot[0])));
  turn[3] = at[0];
  turn[7] = at[1];
  turn[11] = at[2];
  return turn;
}

/** Inverse of a rigid transform. */
export function invert(m: Matrix): Matrix {
  return [m[0], m[4], m[8], -(m[0] * m[3] + m[4] * m[7] + m[8] * m[11]),
    m[1], m[5], m[9], -(m[1] * m[3] + m[5] * m[7] + m[9] * m[11]),
    m[2], m[6], m[10], -(m[2] * m[3] + m[6] * m[7] + m[10] * m[11])];
}

/** A hinge that may turn a full revolution has no end stops. */
export function turnsFully(joint: JointSpec) {
  return joint.type === 'hinge' && joint.limits[1] - joint.limits[0] >= 360 - 1e-9;
}

export function clampJoint(joint: JointSpec, value: number | undefined) {
  if (joint.type === 'fixed') return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return joint.value;
  const [low, high] = joint.limits;
  if (value >= low && value <= high) return value;
  if (turnsFully(joint)) return low + ((((value - low) % 360) + 360) % 360);
  return Math.min(high, Math.max(low, value));
}

/**
 * How the joints connect the parts. Joints are read in the order they are
 * written. A joint that links two groups of parts not yet connected carries
 * one from the other. A joint between parts that are already connected closes
 * a loop: it adds no freedom, and the joints around the loop must move
 * together to keep it shut.
 */
export interface Structure {
  /** Parts that no joint carries. */
  roots: number[];
  /** Carried parts in the order they can be placed. `reversed` means the joint's child carries its parent. */
  edges: { joint: number; part: number; from: number; reversed: boolean }[];
  /** For each part, the joint that carries it, or -1 for a root. */
  carrier: number[];
  /** Joints that close a loop. */
  closures: number[];
  /** For each closing joint, the carrying joints around its loop. */
  cycles: number[][];
  /** For each joint, true when it carries a part and lies on a loop. */
  looped: boolean[];
  /** Joint frames: in the parent, in the child, and their inverses. */
  frames: { parent: Matrix; child: Matrix; parentInverse: Matrix; childInverse: Matrix }[];
  /** Typical size of the mechanism in mm. It makes angle errors comparable with distances. */
  scale: number;
}

const structures = new WeakMap<AssemblySpec, Structure>();

export function structureOf(assembly: AssemblySpec): Structure {
  const known = structures.get(assembly);
  if (known) return known;
  const { parts, joints } = assembly;
  const index = new Map(parts.map((part, i) => [part.name, i]));
  const group = parts.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));

  const links: { joint: number; other: number; reversed: boolean }[][] = parts.map(() => []);
  const carries = joints.map(() => false);
  const closures: number[] = [];
  joints.forEach((joint, j) => {
    const parent = index.get(joint.parent)!;
    const child = index.get(joint.child)!;
    if (find(parent) === find(child)) {
      closures.push(j);
      return;
    }
    group[find(parent)] = find(child);
    carries[j] = true;
    links[parent].push({ joint: j, other: child, reversed: false });
    links[child].push({ joint: j, other: parent, reversed: true });
  });

  // Each connected group stands on its first part that is nobody's child.
  const isChild = parts.map(() => false);
  joints.forEach((joint, j) => {
    if (carries[j]) isChild[index.get(joint.child)!] = true;
  });
  const roots: number[] = [];
  const rooted = new Set<number>();
  parts.forEach((_, i) => {
    if (isChild[i] || rooted.has(find(i))) return;
    rooted.add(find(i));
    roots.push(i);
  });

  const carrier = parts.map(() => -1);
  const from = parts.map(() => -1);
  const edges: Structure['edges'] = [];
  const queue = [...roots];
  const seen = new Set(roots);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const link of links[current]) {
      if (seen.has(link.other)) continue;
      seen.add(link.other);
      carrier[link.other] = link.joint;
      from[link.other] = current;
      edges.push({ joint: link.joint, part: link.other, from: current, reversed: link.reversed });
      queue.push(link.other);
    }
  }

  const looped = joints.map(() => false);
  const ancestors = (part: number) => {
    const chain = [part];
    while (from[chain[chain.length - 1]] >= 0) chain.push(from[chain[chain.length - 1]]);
    return chain;
  };
  const cycles = closures.map((j) => {
    const up = ancestors(index.get(joints[j].parent)!);
    const down = ancestors(index.get(joints[j].child)!);
    // Drop the shared tail: what remains is the path between the two parts.
    while (up.length && down.length && up[up.length - 1] === down[down.length - 1]) {
      up.pop();
      down.pop();
    }
    const cycle = [...up, ...down].map((part) => carrier[part]);
    for (const joint of cycle) looped[joint] = true;
    return cycle;
  });

  const frames = joints.map((joint) => {
    const parent = placement(joint.at, joint.rot);
    const child = placement(joint.childAt, joint.childRot);
    return { parent, child, parentInverse: invert(parent), childInverse: invert(child) };
  });
  const reach = joints.flatMap((joint) => [Math.hypot(...joint.at), Math.hypot(...joint.childAt)]);
  const result = { roots, edges, carrier, closures, cycles, looped, frames, scale: Math.max(10, ...reach) };
  structures.set(assembly, result);
  return result;
}

/** How a joint moves the child's joint frame from the parent's, at a given value. */
export function jointMotion(joint: JointSpec, value: number): Matrix {
  if (joint.type === 'hinge') return axisRotation(joint.axis, value);
  if (joint.type === 'slider') return [1, 0, 0, joint.axis[0] * value, 0, 1, 0, joint.axis[1] * value, 0, 0, 1, joint.axis[2] * value];
  return identity;
}

/** World transform of every part for one value per joint. Values of closing joints are not used. */
export function placeParts(assembly: AssemblySpec, values: number[]): Matrix[] {
  const { roots, edges, frames } = structureOf(assembly);
  const world = new Array<Matrix>(assembly.parts.length);
  for (const root of roots) world[root] = placement(assembly.parts[root].at, assembly.parts[root].rot);
  for (const edge of edges) {
    const joint = assembly.joints[edge.joint];
    const frame = frames[edge.joint];
    const motion = jointMotion(joint, values[edge.joint]);
    world[edge.part] = edge.reversed
      ? multiply(world[edge.from], multiply(frame.child, multiply(invert(motion), frame.parentInverse)))
      : multiply(world[edge.from], multiply(frame.parent, multiply(motion, frame.childInverse)));
  }
  return world;
}

export function jointValues(assembly: AssemblySpec, pose: Pose = {}) {
  return assembly.joints.map((joint) => clampJoint(joint, pose[joint.name]));
}

/** The joints that have a value to set: every moving joint that carries a part. */
export function movingJoints(assembly: AssemblySpec) {
  const { closures } = structureOf(assembly);
  return assembly.joints.filter((joint, j) => joint.type !== 'fixed' && !closures.includes(j));
}

export function defaultPose(assembly: AssemblySpec): Pose {
  return Object.fromEntries(movingJoints(assembly).map((item) => [item.name, item.value]));
}

/** World transform of every part, in the order of assembly.parts. */
export function solvePose(assembly: AssemblySpec, pose: Pose = {}): Matrix[] {
  return placeParts(assembly, jointValues(assembly, pose));
}

/** Box around a part's bounds after a transform. */
export function transformBounds(bounds: { min: Vec3; max: Vec3 }, matrix: Matrix, into: { min: Vec3; max: Vec3 }) {
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.max[0] : bounds.min[0];
    const y = corner & 2 ? bounds.max[1] : bounds.min[1];
    const z = corner & 4 ? bounds.max[2] : bounds.min[2];
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis * 4] * x + matrix[axis * 4 + 1] * y + matrix[axis * 4 + 2] * z + matrix[axis * 4 + 3];
      if (value < into.min[axis]) into.min[axis] = value;
      if (value > into.max[axis]) into.max[axis] = value;
    }
  }
}

export function poseBounds(assembly: AssemblySpec, partBounds: { min: Vec3; max: Vec3 }[], pose?: Pose) {
  const result = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  solvePose(assembly, pose).forEach((matrix, i) => transformBounds(partBounds[i], matrix, result));
  return result;
}

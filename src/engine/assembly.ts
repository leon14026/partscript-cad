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
module part(name = undef, file = undef, at = [0, 0, 0], rot = [0, 0, 0], color = undef) {
    echo(["@partscript", "part", name, file, _ps_v(at), _ps_v(rot), _ps_v(color)]);
}
module joint(name = undef, type = "fixed", parent = undef, child = undef, at = [0, 0, 0], rot = [0, 0, 0], axis = [0, 0, 1], limits = undef, value = undef) {
    echo(["@partscript", "joint", name, type, parent, child, _ps_v(at), _ps_v(rot), _ps_v(axis), _ps_v(limits), _ps_n(value)]);
}
`;

export const recordMarker = '["@partscript"';

export type JointType = 'fixed' | 'hinge' | 'slider';
export type Color = [number, number, number];
/** 3x4 row-major rigid transform: [r00,r01,r02,tx, r10,r11,r12,ty, r20,r21,r22,tz]. */
export type Matrix = number[];

export interface PartSpec {
  name: string;
  file: string;
  /** Placement of a part that no joint carries. */
  at: Vec3;
  rot: Vec3;
  color: Color;
}

export interface JointSpec {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** Joint frame in the parent part's coordinates. The child's origin sits on it. */
  at: Vec3;
  rot: Vec3;
  /** Motion axis in the joint frame. Unit length. */
  axis: Vec3;
  /** Travel limits: degrees for a hinge, millimetres for a slider. */
  limits: [number, number];
  /** Value the model opens with. */
  value: number;
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
      const file = text(fields[3], what, 'file name');
      if (!fileNamePattern.test(file)) fail(what, `"${file}" is not a project file name. Use a name such as "arm.scad".`);
      const at = vector(fields[4], what, 'at') as Vec3;
      const rot = vector(fields[5], what, 'rot') as Vec3;
      if (at.some((v) => v !== 0) || rot.some((v) => v !== 0)) placed.add(name);
      parts.push({ name, file, at, rot, color: color(fields[6], what, parts.length) });
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
      joints.push({ name, type, parent, child, at, rot, axis, limits, value });
    }
  }

  if (!parts.length) throw new CadError('The assembly has joints and no parts. Add part("name", "file.scad") for each part.');
  const names = new Set(parts.map((item) => item.name));
  const carrier = new Map<string, JointSpec>();
  for (const item of joints) {
    const what = `joint("${item.name}")`;
    if (!names.has(item.parent)) fail(what, `parent "${item.parent}" is not a part. Declare it with part().`);
    if (!names.has(item.child)) fail(what, `child "${item.child}" is not a part. Declare it with part().`);
    if (item.parent === item.child) fail(what, 'parent and child must be different parts.');
    const other = carrier.get(item.child);
    if (other) fail(what, `"${item.child}" is already carried by joint("${other.name}"). A part can hang from one joint. Closed loops are unavailable in this version.`);
    if (placed.has(item.child)) fail(what, `"${item.child}" also has at or rot on its part() line. Place it with the joint's at and rot.`);
    carrier.set(item.child, item);
  }
  for (const item of joints) {
    let current = item.parent;
    for (let steps = 0; carrier.has(current); steps++) {
      current = carrier.get(current)!.parent;
      if (current === item.child || steps > joints.length) {
        fail(`joint("${item.name}")`, 'the joints form a loop. Each part must lead back to a part that no joint carries.');
      }
    }
  }
  return { parts, joints };
}

/** A single part file is shown and exported as an assembly of one part. */
export function singlePart(file: string): AssemblySpec {
  return { parts: [{ name: file.replace(/\.scad$/i, ''), file, at: [0, 0, 0], rot: [0, 0, 0], color: palette[0] }], joints: [] };
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

export function clampJoint(joint: JointSpec, value: number | undefined) {
  if (joint.type === 'fixed') return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return joint.value;
  return Math.min(joint.limits[1], Math.max(joint.limits[0], value));
}

export function defaultPose(assembly: AssemblySpec): Pose {
  return Object.fromEntries(assembly.joints.filter((item) => item.type !== 'fixed').map((item) => [item.name, item.value]));
}

/** World transform of every part, in the order of assembly.parts. */
export function solvePose(assembly: AssemblySpec, pose: Pose = {}): Matrix[] {
  const carrier = new Map(assembly.joints.map((item) => [item.child, item]));
  const byName = new Map(assembly.parts.map((item) => [item.name, item]));
  const solved = new Map<string, Matrix>();

  function world(name: string): Matrix {
    const known = solved.get(name);
    if (known) return known;
    const joint = carrier.get(name);
    let result: Matrix;
    if (!joint) {
      const part = byName.get(name)!;
      result = placement(part.at, part.rot);
    } else {
      const value = clampJoint(joint, pose[joint.name]);
      const motion = joint.type === 'hinge' ? axisRotation(joint.axis, value)
        : joint.type === 'slider' ? placement(joint.axis.map((v) => v * value) as Vec3, [0, 0, 0])
          : identity;
      result = multiply(world(joint.parent), multiply(placement(joint.at, joint.rot), motion));
    }
    solved.set(name, result);
    return result;
  }
  return assembly.parts.map((item) => world(item.name));
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

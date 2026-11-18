import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import type { Matrix } from './assembly.ts';
import { CadError, type MeasurePick, type MeasureResult, type PartMesh, type Reading, type Vec3 } from './protocol.ts';

/** What measure() needs of each part of the assembly. */
export interface MeasuredPart {
  name: string;
  /** Placement in the current pose. */
  matrix: Matrix;
  mesh: PartMesh;
  /** The exact solid. Undefined for a faceted part. */
  shape?: ShapeHandle;
}

/** Axes, normals and lines count as parallel within this angle. */
const parallelDegrees = 0.01;
const sameDistance = 5e-4;

type Point = { x: number; y: number; z: number };

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(a: Vec3): Vec3 {
  return scale(a, 1 / Math.hypot(...a));
}

const vec = (p: Point): Vec3 => [p.x, p.y, p.z];
const point = (p: Vec3): Point => ({ x: p[0], y: p[1], z: p[2] });
const degrees = (radians: number) => (radians * 180) / Math.PI;

/** A point through a 3x4 row-major matrix (the form of every part placement). */
export function transformPoint(m: Matrix, p: ArrayLike<number>, at = 0): Vec3 {
  const [x, y, z] = [p[at], p[at + 1], p[at + 2]];
  return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}

/** Area, centre and spread along a direction of the triangles of one face, in world coordinates. */
function faceTriangles(mesh: PartMesh, matrix: Matrix, face: number, along?: Vec3) {
  let area = 0;
  let centre: Vec3 = [0, 0, 0];
  let low = Infinity;
  let high = -Infinity;
  for (let t = 0; t < mesh.faceOf.length; t++) {
    if (mesh.faceOf[t] !== face) continue;
    const corners = [0, 1, 2].map((k) => transformPoint(matrix, mesh.positions, mesh.indices[t * 3 + k] * 3));
    const size = Math.hypot(...cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]))) / 2;
    area += size;
    centre = add(centre, scale(add(add(corners[0], corners[1]), corners[2]), size / 3));
    if (along) {
      for (const corner of corners) {
        low = Math.min(low, dot(corner, along));
        high = Math.max(high, dot(corner, along));
      }
    }
  }
  return { area, centre: area > 0 ? scale(centre, 1 / area) : centre, low, high };
}

/** A picked thing as the pair readings see it, in world coordinates. */
interface Subject {
  title: string;
  readings: Reading[];
  /** A flat face: its normal, and a point on it that lies on the face itself. */
  plane?: { normal: Vec3; at: Vec3 };
  /** A cylinder axis, a circle's axis or a straight edge. `at` is a point on the axis in the middle of the face or edge. */
  axis?: { dir: Vec3; at: Vec3; round: boolean };
  /** A corner. */
  corner?: Vec3;
  /** The placed sub-shape. Only exact parts have one. */
  shape?: ShapeHandle;
}

const mm = (label: string, value: number): Reading => ({ label, value, unit: 'mm' });
const area = (value: number): Reading => ({ label: 'Area', value, unit: 'mm²' });
const angle = (value: number): Reading => ({ label: 'Angle', value, unit: '°' });

function pickOf(parts: MeasuredPart[], pick: MeasurePick) {
  const part = parts[pick.part];
  if (!part) throw new CadError('That part is not in the current model. Run the code again, then pick again.');
  return part;
}

function describeFaceted(part: MeasuredPart, pick: MeasurePick): Subject {
  const { mesh, matrix } = part;
  if (pick.type === 'edge') {
    throw new CadError(`${part.name} is a faceted part, so its edges cannot be measured. MeasurePick a face or a corner.`);
  }
  if (pick.type === 'vertex') {
    if (pick.index * 3 + 2 >= mesh.corners.length) throw new CadError('That corner is not in the current model. Run the code again, then pick again.');
    const corner = transformPoint(matrix, mesh.corners, pick.index * 3);
    return { title: `${part.name}: corner`, readings: [mm('X', corner[0]), mm('Y', corner[1]), mm('Z', corner[2])], corner };
  }
  const found = faceTriangles(mesh, matrix, pick.index);
  if (found.area === 0) throw new CadError('That face is not in the current model. Run the code again, then pick again.');
  return { title: `${part.name}: face of a faceted part`, readings: [area(found.area)] };
}

function describeExact(kernel: OcctKernel, part: MeasuredPart, shape: ShapeHandle, pick: MeasurePick): Subject {
  const { mesh, matrix } = part;
  const subs = kernel.getSubShapes(shape, pick.type);
  if (pick.index >= subs.length) throw new CadError('That face, edge or corner is not in the current model. Run the code again, then pick again.');
  // The placed sub-shape reports its surface, curve or position in world coordinates.
  const placed = kernel.located(subs[pick.index], matrix);

  if (pick.type === 'vertex') {
    const corner = vec(kernel.vertexPosition(placed));
    return { title: `${part.name}: corner`, readings: [mm('X', corner[0]), mm('Y', corner[1]), mm('Z', corner[2])], corner, shape: placed };
  }

  if (pick.type === 'edge') {
    const length = kernel.curveLength(placed);
    const { first, last } = kernel.curveParameters(placed);
    const middle = vec(kernel.curvePointAtParam(placed, (first + last) / 2));
    const data = kernel.curveData(placed);
    if (data.kind === 'line') {
      return {
        title: `${part.name}: straight edge`,
        readings: [mm('Length', length)],
        axis: { dir: unit(vec(data.direction)), at: middle, round: false },
        shape: placed,
      };
    }
    if (data.kind === 'circle') {
      return {
        title: `${part.name}: ${kernel.curveIsClosed(placed) ? 'circular edge' : 'arc'}`,
        readings: [mm('Diameter', 2 * data.radius), mm('Length', length)],
        axis: { dir: unit(vec(data.axis)), at: vec(data.center), round: true },
        shape: placed,
      };
    }
    return { title: `${part.name}: curved edge`, readings: [mm('Length', length)], shape: placed };
  }

  const exact = kernel.getSurfaceArea(placed);
  const data = kernel.surfaceData(placed);
  if (data.kind === 'plane') {
    const normal = unit(vec(data.normal));
    // A point of the face itself, so a distance line starts on the part and not at the plane's origin.
    const at = faceTriangles(mesh, matrix, pick.index).centre;
    return { title: `${part.name}: flat face`, readings: [area(exact)], plane: { normal, at }, shape: placed };
  }
  if (data.kind === 'cylinder') {
    const dir = unit(vec(data.axis));
    const origin = vec(data.location);
    const { low, high } = faceTriangles(mesh, matrix, pick.index, dir);
    const at = add(origin, scale(dir, (low + high) / 2 - dot(origin, dir)));
    return {
      title: `${part.name}: cylindrical face`,
      readings: [mm('Diameter', 2 * data.radius), mm('Length', high - low), area(exact)],
      axis: { dir, at, round: true },
      shape: placed,
    };
  }
  if (data.kind === 'cone') {
    // Its axis is what a bore or a shaft is lined up with.
    const dir = unit(vec(data.axis));
    const origin = vec(data.location);
    const { low, high } = faceTriangles(mesh, matrix, pick.index, dir);
    const at = add(origin, scale(dir, (low + high) / 2 - dot(origin, dir)));
    return {
      title: `${part.name}: conical face`,
      readings: [{ label: 'Half angle', value: degrees(Math.abs(data.semiAngle)), unit: '°' }, area(exact)],
      axis: { dir, at, round: true },
      shape: placed,
    };
  }
  if (data.kind === 'sphere') {
    return { title: `${part.name}: spherical face`, readings: [mm('Diameter', 2 * data.radius), area(exact)], shape: placed };
  }
  return { title: `${part.name}: curved face`, readings: [area(exact)], shape: placed };
}

function describe(kernel: OcctKernel, parts: MeasuredPart[], pick: MeasurePick): Subject {
  const part = pickOf(parts, pick);
  return part.shape ? describeExact(kernel, part, part.shape, pick) : describeFaceted(part, pick);
}

/** Angle between two directions that have no sense (a plane's normal, an axis), 0 to 90 degrees. */
function degreesBetween(a: Vec3, b: Vec3) {
  return degrees(Math.acos(Math.min(1, Math.abs(dot(a, b)))));
}

/** The point of a plane nearest to `p`. */
function foot(p: Vec3, plane: { normal: Vec3; at: Vec3 }) {
  return sub(p, scale(plane.normal, dot(sub(p, plane.at), plane.normal)));
}

/** The point of an axis nearest to `p`. */
function onAxis(p: Vec3, axis: { dir: Vec3; at: Vec3 }) {
  return add(axis.at, scale(axis.dir, dot(sub(p, axis.at), axis.dir)));
}

function pairReadings(kernel: OcctKernel, a: Subject, b: Subject): { between: Reading[]; line?: [Vec3, Vec3]; notes: string[] } {
  const readings: Reading[] = [];
  const notes: string[] = [];
  let line: [Vec3, Vec3] | undefined;

  if (a.corner && b.corner) {
    const d = sub(b.corner, a.corner);
    return {
      between: [mm('Distance', Math.hypot(...d)), mm('ΔX', d[0]), mm('ΔY', d[1]), mm('ΔZ', d[2])],
      line: [a.corner, b.corner],
      notes,
    };
  }

  if (!a.shape || !b.shape) {
    notes.push('Distances and angles need exact parts. A faceted part can only be measured from corner to corner.');
    return { between: readings, notes };
  }

  // The reading that a dimension on a drawing would give, with the line that shows it.
  if (a.plane && b.plane) {
    const degreesApart = degreesBetween(a.plane.normal, b.plane.normal);
    readings.push(angle(degreesApart));
    if (degreesApart < parallelDegrees) {
      const end = foot(a.plane.at, b.plane);
      readings.unshift(mm('Distance between faces', Math.hypot(...sub(end, a.plane.at))));
      line = [a.plane.at, end];
    }
  } else if (a.axis && b.axis) {
    const degreesApart = degreesBetween(a.axis.dir, b.axis.dir);
    readings.push(angle(degreesApart));
    if (degreesApart < parallelDegrees) {
      const end = onAxis(a.axis.at, b.axis);
      readings.unshift(mm(a.axis.round && b.axis.round ? 'Centre-to-centre distance' : 'Distance between lines', Math.hypot(...sub(end, a.axis.at))));
      line = [a.axis.at, end];
    }
  } else if ((a.plane && b.axis) || (a.axis && b.plane)) {
    const plane = (a.plane ?? b.plane)!;
    const axis = (a.axis ?? b.axis)!;
    const degreesApart = degrees(Math.asin(Math.min(1, Math.abs(dot(axis.dir, plane.normal)))));
    readings.push(angle(degreesApart));
    if (degreesApart < parallelDegrees) {
      const end = foot(axis.at, plane);
      readings.unshift(mm('Distance from axis to face', Math.hypot(...sub(end, axis.at))));
      line = [axis.at, end];
    }
  }

  const shortest = kernel.distanceBetween(a.shape, b.shape);
  // Two faces that overlap in a view along their normal are as far apart as their planes: one number says it.
  if (!readings.some((reading) => reading.label === 'Distance between faces' && Math.abs(reading.value - shortest) < sameDistance)) {
    readings.push(mm('Shortest distance', shortest));
  }

  // A corner and a face or an edge: the nearest point of the other one is its projection, when the projection gives the shortest distance.
  if (!line && (a.corner || b.corner)) {
    const [cornerSubject, other] = a.corner ? [a, b] : [b, a];
    const corner = cornerSubject.corner!;
    try {
      const probe = other.shape!;
      const nearest = kernel.subShapeCount(probe, 'face') > 0
        ? vec(kernel.projectPointOnFace(probe, point(corner)))
        : vec(kernel.projectPointOnEdge(probe, point(corner)).point);
      if (Math.abs(Math.hypot(...sub(nearest, corner)) - shortest) < 1e-6 * Math.max(1, shortest)) {
        line = a.corner ? [corner, nearest] : [nearest, corner];
      }
    } catch {
      // The kernel found no projection; the reading stays, the line is left out.
    }
  }
  return { between: readings, line, notes };
}

/**
 * Read one or two picks in the current pose. Pure geometry: the caller owns the kernel handles and
 * wraps this in checkpoint / releaseSince. Exact parts are read from the solid in the kernel;
 * faceted parts from their mesh.
 */
export function measure(kernel: OcctKernel, parts: MeasuredPart[], picks: MeasurePick[]): MeasureResult {
  if (picks.length < 1 || picks.length > 2) throw new CadError('MeasurePick one or two things to measure.');
  const subjects = picks.map((pick) => describe(kernel, parts, pick));
  const notes: string[] = [];
  if (picks.some((pick) => !parts[pick.part].shape)) notes.push('A faceted part is measured on its mesh, not on exact geometry.');
  if (subjects.length === 1) {
    return { items: [{ title: subjects[0].title, readings: subjects[0].readings }], between: [], notes };
  }
  const pair = pairReadings(kernel, subjects[0], subjects[1]);
  return {
    items: subjects.map(({ title, readings }) => ({ title, readings })),
    between: pair.between,
    line: pair.line,
    notes: [...notes, ...pair.notes],
  };
}

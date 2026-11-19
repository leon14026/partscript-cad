import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import type { PartMesh } from '../engine/protocol.ts';
import { viewFrames } from './frames.ts';
import { meshViews } from './mesh.ts';
import type { Curve, HoleData, PartDrawing, SectionData, TurnedData, Vec2, Vec3, ViewData, ViewName } from './types.ts';

type Point = { x: number; y: number; z: number };
type Axis = 0 | 1 | 2;

const point = (a: ArrayLike<number>): Point => ({ x: a[0], y: a[1], z: a[2] });
const toVec = (p: Point): Vec3 => [p.x, p.y, p.z];
const TAU = Math.PI * 2;

/** More hidden curves than this in one view are not returned: such a view is a tangle that no one would read. */
export const hiddenReturnLimit = 1000;

const quantum = (value: number) => Math.round(value * 1000);

/** A key that is the same for two curves that draw the same line, so a seam that lies under a silhouette is not drawn twice. */
function curveKey(curve: Curve) {
  if (curve.kind === 'line') {
    const a = `${quantum(curve.a[0])},${quantum(curve.a[1])}`;
    const b = `${quantum(curve.b[0])},${quantum(curve.b[1])}`;
    return a < b ? `l${a}|${b}` : `l${b}|${a}`;
  }
  if (curve.kind === 'circle') return `c${quantum(curve.c[0])},${quantum(curve.c[1])},${quantum(curve.r)}`;
  if (curve.kind === 'arc') return `a${quantum(curve.c[0])},${quantum(curve.c[1])},${quantum(curve.r)},${quantum(curve.from)},${quantum(curve.to)}`;
  const first = curve.points[0];
  const last = curve.points[curve.points.length - 1];
  return `p${curve.points.length},${quantum(first[0])},${quantum(first[1])},${quantum(last[0])},${quantum(last[1])}`;
}

/** The lower left and upper right of a curve. */
export function curveBox(curve: Curve): [number, number, number, number] {
  if (curve.kind === 'line') return [Math.min(curve.a[0], curve.b[0]), Math.min(curve.a[1], curve.b[1]), Math.max(curve.a[0], curve.b[0]), Math.max(curve.a[1], curve.b[1])];
  if (curve.kind === 'circle') return [curve.c[0] - curve.r, curve.c[1] - curve.r, curve.c[0] + curve.r, curve.c[1] + curve.r];
  if (curve.kind === 'arc') {
    const angles = [curve.from, curve.to];
    for (let quarter = Math.ceil(curve.from / (Math.PI / 2)); quarter * (Math.PI / 2) <= curve.to; quarter++) angles.push(quarter * (Math.PI / 2));
    const xs = angles.map((angle) => curve.c[0] + curve.r * Math.cos(angle));
    const ys = angles.map((angle) => curve.c[1] + curve.r * Math.sin(angle));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const xs = curve.points.map((p) => p[0]);
  const ys = curve.points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function boxOf(curves: Curve[]): [number, number, number, number] {
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const curve of curves) {
    const next = curveBox(curve);
    box = [Math.min(box[0], next[0]), Math.min(box[1], next[1]), Math.max(box[2], next[2]), Math.max(box[3], next[3])];
  }
  return Number.isFinite(box[0]) ? box : [0, 0, 0, 0];
}

/** Drop curves that draw the same line as an earlier one. */
export function dedupe(curves: Curve[]) {
  const seen = new Set<string>();
  return curves.filter((curve) => {
    const key = curveKey(curve);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A polyline that is straight to within a tenth of a micrometre is a line. */
function simplified(points: Vec2[]): Curve {
  const a = points[0];
  const b = points[points.length - 1];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length > 1e-9) {
    let deviation = 0;
    for (const p of points) deviation = Math.max(deviation, Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / length);
    if (deviation < 1e-4) return { kind: 'line', a, b };
  }
  return { kind: 'poly', points };
}

/** The curves of the edges of a compound that `projectEdges` returned, in the plane of the view. */
function curvesOf(kernel: OcctKernel, compound: ShapeHandle | undefined, deflection: number): Curve[] {
  const out: Curve[] = [];
  if (!compound) return out;
  for (const edge of kernel.getSubShapes(compound, 'edge')) {
    const data = kernel.curveData(edge);
    if (data.kind === 'line') {
      const a: Vec2 = [data.point.x + data.direction.x * data.first, data.point.y + data.direction.y * data.first];
      const b: Vec2 = [data.point.x + data.direction.x * data.last, data.point.y + data.direction.y * data.last];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) out.push({ kind: 'line', a, b });
    } else if (data.kind === 'circle' && Math.abs(data.axis.z) > 0.999999) {
      const sign = data.axis.z > 0 ? 1 : -1;
      const base = Math.atan2(data.xDirection.y, data.xDirection.x);
      const span = data.last - data.first;
      const c: Vec2 = [data.center.x, data.center.y];
      if (span >= TAU - 1e-6) out.push({ kind: 'circle', c, r: data.radius });
      else {
        const from = sign > 0 ? base + data.first : base - data.last;
        const start = ((from % TAU) + TAU) % TAU;
        out.push({ kind: 'arc', c, r: data.radius, from: start, to: start + span });
      }
    } else {
      const wire = kernel.wireframe(edge, deflection);
      const points: Vec2[] = [];
      for (let i = 0; i + 2 < wire.points.length; i += 3) points.push([wire.points[i], wire.points[i + 1]]);
      if (points.length >= 2) out.push(simplified(points));
    }
  }
  return out;
}

/** The visible and hidden curves of one view of a solid. */
export function projectView(kernel: OcctKernel, shape: ShapeHandle, name: Exclude<ViewName, 'section'> | 'section', frame: { dir: Vec3; x: Vec3 }, deflection: number, wantHidden = true): ViewData {
  const mark = kernel.checkpoint();
  try {
    const result = kernel.projectEdges(shape, point([0, 0, 0]), point(frame.dir), point(frame.x));
    // A category with no edges is handle 0 (F33). The smooth edges are seams and tangent joins, which a drawing leaves out.
    const pick = (handle: ShapeHandle) => (handle ? handle : undefined);
    const visible = dedupe([...curvesOf(kernel, pick(result.visibleOutline), deflection), ...curvesOf(kernel, pick(result.visibleSharp), deflection)]);
    let hidden = wantHidden ? dedupe([...curvesOf(kernel, pick(result.hiddenOutline), deflection), ...curvesOf(kernel, pick(result.hiddenSharp), deflection)]) : [];
    const count = hidden.length;
    let omitted = 0;
    if (count > hiddenReturnLimit) {
      omitted = count;
      hidden = [];
    }
    return { name, visible, hidden, hiddenOmitted: omitted, box: boxOf(visible) };
  } finally {
    kernel.releaseSince(mark);
  }
}

/** Where a plane's or a cylinder's surface lies and which way the material is. */
interface FaceInfo {
  kind: string;
  index: number;
  /** For a plane: the normal pointing out of the material. */
  out?: Vec3;
  location?: Vec3;
  axis?: Vec3;
  radius?: number;
  /** For a cylinder: true when the material is outside the surface, as on a pin. */
  convex?: boolean;
  span?: number;
  vRange?: [number, number];
}

/** A cylinder or a ring of flat facets that stands for one. */
interface Round {
  axis: Axis;
  /** The axis position in the other two coordinates, in axis order. */
  across: Vec2;
  radius: number;
  lo: number;
  hi: number;
  hole: boolean;
  members: number[];
  sides?: number;
}

const axisOf = (v: Vec3): Axis | undefined => {
  for (const a of [0, 1, 2] as const) if (Math.abs(Math.abs(v[a]) - 1) < 1e-6) return a;
  return undefined;
};

const others = (axis: Axis): [Axis, Axis] => (axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]);

/** Solve a 3 by 3 system, or return undefined when it is singular. */
function solve3(m: number[][], b: number[]): number[] | undefined {
  const a = m.map((row, i) => [...row, b[i]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-12) return undefined;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < 4; k++) a[row][k] -= factor * a[column][k];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

export interface Features {
  holes: HoleData[];
  turned?: TurnedData;
  notes: string[];
}

/** Hash bound for matching the faces that `adjacentFaces` returns with the faces of the solid. */
const hashBound = 2_000_000_000;
/** Beyond this many faces, features are not read: it would take longer than the drawing is worth. */
const featureFaceLimit = 3000;

/** Read the holes and the turned diameters from the faces of a solid. */
export function readFeatures(kernel: OcctKernel, shape: ShapeHandle, hasFlatRounds: boolean, bounds: { min: Vec3; max: Vec3 }): Features {
  const notes: string[] = [];
  const faces = kernel.getSubShapes(shape, 'face');
  if (faces.length > featureFaceLimit) {
    return { holes: [], notes: [`The part has ${faces.length} faces, too many to read holes from, so only its views and overall size are drawn.`] };
  }
  const hashes = faces.map((face) => kernel.hashCode(face, hashBound));
  const byHash = new Map<number, number[]>();
  hashes.forEach((hash, i) => byHash.set(hash, [...(byHash.get(hash) ?? []), i]));

  const adjacency = new Map<number, number[]>();
  const neighbours = (i: number) => {
    let found = adjacency.get(i);
    if (found) return found;
    found = [];
    for (const other of kernel.adjacentFaces(shape, faces[i])) {
      const candidates = byHash.get(kernel.hashCode(other, hashBound)) ?? [];
      const match = candidates.length === 1 ? candidates[0] : candidates.find((j) => kernel.isSame(faces[j], other));
      if (match !== undefined && match !== i) found.push(match);
    }
    adjacency.set(i, found);
    return found;
  };

  const infos: FaceInfo[] = faces.map((face, index) => {
    const data = kernel.surfaceData(face);
    if (data.kind === 'plane') {
      const flip = kernel.shapeOrientation(face) === 'reversed' ? -1 : 1;
      return { kind: 'plane', index, out: [data.normal.x * flip, data.normal.y * flip, data.normal.z * flip], location: toVec(data.location) };
    }
    if (data.kind === 'cylinder') {
      const bounds2 = kernel.uvBounds(face);
      const u = (bounds2.uMin + bounds2.uMax) / 2;
      const v = (bounds2.vMin + bounds2.vMax) / 2;
      const normal = kernel.surfaceNormal(face, u, v);
      const onSurface = kernel.pointOnSurface(face, u, v);
      const radial = normal.x * (onSurface.x - data.location.x) + normal.y * (onSurface.y - data.location.y) + normal.z * (onSurface.z - data.location.z);
      return { kind: 'cylinder', index, location: toVec(data.location), axis: toVec(data.axis), radius: data.radius, convex: radial > 0, span: bounds2.uMax - bounds2.uMin, vRange: [bounds2.vMin, bounds2.vMax] };
    }
    return { kind: data.kind, index };
  });

  const rounds: Round[] = [];
  let partialCylinders = 0;
  let skewCylinders = 0;
  const cylinderGroups = new Map<string, { info: FaceInfo[]; axis: Axis }>();
  for (const info of infos) {
    if (info.kind !== 'cylinder') continue;
    const axis = axisOf(info.axis!);
    if (axis === undefined) {
      skewCylinders++;
      continue;
    }
    const [p, q] = others(axis);
    const key = `${axis}|${quantum(info.location![p])}|${quantum(info.location![q])}|${quantum(info.radius!)}|${info.convex}`;
    const group = cylinderGroups.get(key) ?? { info: [], axis };
    group.info.push(info);
    cylinderGroups.set(key, group);
  }
  for (const group of cylinderGroups.values()) {
    const first = group.info[0];
    const total = group.info.reduce((sum, info) => sum + info.span!, 0);
    if (Math.abs(total - TAU) > 1e-3) {
      partialCylinders += group.info.length;
      continue;
    }
    const axis = group.axis;
    const sign = first.axis![axis];
    const [p, q] = others(axis);
    const along = group.info.flatMap((info) => info.vRange!.map((v) => info.location![axis] + sign * v));
    rounds.push({ axis, across: [first.location![p], first.location![q]], radius: first.radius!, lo: Math.min(...along), hi: Math.max(...along), hole: !first.convex, members: group.info.map((info) => info.index) });
  }

  if (hasFlatRounds) rounds.push(...prismRounds(kernel, faces, infos, neighbours));

  const holes: HoleData[] = [];
  const holeRounds = rounds.filter((round) => round.hole);

  // Where each hole round ends: the flat faces at its two ends, with the way they face along the axis.
  const memberSet = (round: Round) => new Set(round.members);
  const endPlanes = (round: Round) => {
    const own = memberSet(round);
    const lo = new Map<number, number>();
    const hi = new Map<number, number>();
    for (const member of round.members) {
      for (const j of neighbours(member)) {
        const info = infos[j];
        if (own.has(j) || info.kind !== 'plane') continue;
        const n = info.out![round.axis];
        if (Math.abs(Math.abs(n) - 1) > 1e-6) continue;
        const at = info.location![round.axis];
        if (Math.abs(at - round.lo) < 1e-4) lo.set(j, n);
        else if (Math.abs(at - round.hi) < 1e-4) hi.set(j, n);
      }
    }
    return { lo, hi };
  };
  const ends = new Map<Round, ReturnType<typeof endPlanes>>(holeRounds.map((round) => [round, endPlanes(round)]));

  // Rounds on one axis line that share the flat face between them are one hole with steps: a counterbore.
  const stackOf = new Map<Round, Round[]>();
  for (const round of holeRounds) {
    if (stackOf.has(round)) continue;
    const stack = [round];
    stackOf.set(round, stack);
    for (let grew = true; grew;) {
      grew = false;
      for (const other of holeRounds) {
        if (stackOf.has(other)) continue;
        const joins = stack.some((member) =>
          member.axis === other.axis && Math.abs(member.across[0] - other.across[0]) < 1e-3 && Math.abs(member.across[1] - other.across[1]) < 1e-3 &&
          (Math.abs(member.hi - other.lo) < 1e-4 || Math.abs(other.hi - member.lo) < 1e-4) &&
          ([...ends.get(member)!.hi.keys()].some((j) => ends.get(other)!.lo.has(j)) || [...ends.get(member)!.lo.keys()].some((j) => ends.get(other)!.hi.has(j))));
        if (joins) {
          stack.push(other);
          stackOf.set(other, stack);
          grew = true;
        }
      }
    }
  }

  const done = new Set<Round[]>();
  for (const stack of stackOf.values()) {
    if (done.has(stack)) continue;
    done.add(stack);
    stack.sort((a, b) => a.lo - b.lo);
    const first = stack[0];
    const last = stack[stack.length - 1];
    const axis = first.axis;
    const [p, q] = others(axis);
    const place = (along: number): Vec3 => {
      const at: Vec3 = [0, 0, 0];
      at[axis] = along;
      at[p] = first.across[0];
      at[q] = first.across[1];
      return at;
    };
    const stateAt = (planes: Map<number, number>, openSign: number): 'open' | 'closed' | 'unknown' => {
      const signs = new Set([...planes.values()].map((n) => Math.sign(n)));
      if (signs.has(openSign)) return 'open';
      if (signs.has(-openSign)) return 'closed';
      return 'unknown';
    };
    // The ends of the stack are the low end of its first round and the high end of its last. A flat face shared with the next round is no end.
    const sharedWithNext = (a: Round, b: Round) => new Set([...ends.get(a)!.hi.keys()].filter((j) => ends.get(b)!.lo.has(j)));
    const lowPlanes = new Map(ends.get(first)!.lo);
    const highPlanes = new Map(ends.get(last)!.hi);
    if (stack.length > 1) {
      for (const j of sharedWithNext(first, stack[1])) lowPlanes.delete(j);
      for (const j of sharedWithNext(stack[stack.length - 2], last)) highPlanes.delete(j);
    }
    const low = stateAt(lowPlanes, -1);
    const high = stateAt(highPlanes, 1);
    const sides = first.sides;
    const describe = (round: Round) => ({ diameter: 2 * round.radius, length: round.hi - round.lo });

    let hole: HoleData | undefined;
    if (stack.length === 1) {
      if (low === 'open' && high === 'open') hole = { axis, at: place(first.lo), diameter: describe(first).diameter, through: true, depth: first.hi - first.lo, sides };
      else if (low === 'open' && high === 'closed') hole = { axis, at: place(first.lo), diameter: describe(first).diameter, through: false, depth: first.hi - first.lo, sides };
      else if (low === 'closed' && high === 'open') hole = { axis, at: place(first.hi), diameter: describe(first).diameter, through: false, depth: first.hi - first.lo, sides };
    } else if (stack.length === 2) {
      const [a, b] = stack;
      const through = low === 'open' && high === 'open';
      if (through && a.radius > b.radius + 1e-6) hole = { axis, at: place(a.lo), diameter: 2 * b.radius, through: true, depth: last.hi - first.lo, bore: { diameter: 2 * a.radius, depth: a.hi - a.lo }, sides: b.sides };
      else if (through && b.radius > a.radius + 1e-6) hole = { axis, at: place(b.hi), diameter: 2 * a.radius, through: true, depth: last.hi - first.lo, bore: { diameter: 2 * b.radius, depth: b.hi - b.lo }, sides: a.sides };
      else if (low === 'open' && high === 'closed' && a.radius > b.radius + 1e-6) hole = { axis, at: place(a.lo), diameter: 2 * b.radius, through: false, depth: b.hi - b.lo, bore: { diameter: 2 * a.radius, depth: a.hi - a.lo }, sides: b.sides };
      else if (low === 'closed' && high === 'open' && b.radius > a.radius + 1e-6) hole = { axis, at: place(b.hi), diameter: 2 * a.radius, through: false, depth: a.hi - a.lo, bore: { diameter: 2 * b.radius, depth: b.hi - b.lo }, sides: a.sides };
    }
    if (hole) {
      holes.push(hole);
    } else {
      const where = (['x', 'y', 'z'] as const).map((name, i) => `${name} ${Math.round(place(0)[i] * 100) / 100}`).filter((_, i) => i !== axis).join(', ');
      notes.push(`A round cut at ${where} is not a plain through, blind or counterbored hole, so it is drawn but not dimensioned.`);
    }
  }

  holes.sort((a, b) => a.axis - b.axis || a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]);

  const turned = readTurned(rounds, bounds);

  const count = (kinds: string[]) => infos.filter((info) => kinds.includes(info.kind)).length;
  if (partialCylinders) notes.push(partialCylinders === 1 ? '1 rounded face (a fillet, slot end or part-round hole) is drawn but not dimensioned.' : `${partialCylinders} rounded faces (fillets, slot ends or part-round holes) are drawn but not dimensioned.`);
  if (skewCylinders) notes.push(`${skewCylinders} ${skewCylinders === 1 ? 'cylinder is' : 'cylinders are'} on a skewed axis, drawn but not dimensioned.`);
  if (count(['cone'])) notes.push(`${count(['cone'])} conical ${count(['cone']) === 1 ? 'face (a countersink or chamfer) is' : 'faces (countersinks or chamfers) are'} drawn but not dimensioned.`);
  if (count(['sphere', 'torus', 'bspline', 'bezier', 'revolution', 'extrusion', 'offset', 'other'])) {
    const n = count(['sphere', 'torus', 'bspline', 'bezier', 'revolution', 'extrusion', 'offset', 'other']);
    notes.push(`${n} other curved ${n === 1 ? 'face is' : 'faces are'} drawn but not dimensioned.`);
  }
  // Two holes at the same place, such as the two sides of a hole read twice, say it once.
  return { holes, turned, notes: [...new Set(notes)] };
}

/**
 * Rings of flat faces that `$fn` made out of a hole: eight or more equal facets around an axis, each turning the same angle from the next.
 * The hole's diameter is that of the circle through the corners, as OpenSCAD draws it.
 */
function prismRounds(kernel: OcctKernel, faces: ShapeHandle[], infos: FaceInfo[], neighbours: (i: number) => number[]): Round[] {
  const found: Round[] = [];
  for (const axis of [0, 1, 2] as const) {
    const candidates = new Set(infos.filter((info) => info.kind === 'plane' && Math.abs(info.out![axis]) < 1e-6).map((info) => info.index));
    const links = new Map<number, number[]>();
    for (const i of candidates) {
      const ni = infos[i].out!;
      for (const j of neighbours(i)) {
        if (!candidates.has(j)) continue;
        const nj = infos[j].out!;
        const angle = Math.acos(Math.max(-1, Math.min(1, ni[0] * nj[0] + ni[1] * nj[1] + ni[2] * nj[2])));
        if (angle > 0.0175 && angle < 0.8) links.set(i, [...(links.get(i) ?? []), j]);
      }
    }
    const seen = new Set<number>();
    for (const start of links.keys()) {
      if (seen.has(start)) continue;
      const ring: number[] = [];
      const pending = [start];
      seen.add(start);
      while (pending.length) {
        const i = pending.pop()!;
        ring.push(i);
        for (const j of links.get(i) ?? []) if (!seen.has(j)) { seen.add(j); pending.push(j); }
      }
      const n = ring.length;
      if (n < 8 || ring.some((i) => (links.get(i) ?? []).length !== 2)) continue;
      const turn = TAU / n;
      const [p, q] = others(axis);
      let uniform = true;
      for (const i of ring) for (const j of links.get(i)!) {
        const a = infos[i].out!;
        const b = infos[j].out!;
        if (Math.abs(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) - turn) > 2e-3) uniform = false;
      }
      if (!uniform) continue;
      // The centre and the signed apothem from n_i . c - a = d_i over all the facets, by least squares.
      const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const rhs = [0, 0, 0];
      for (const i of ring) {
        const row = [infos[i].out![p], infos[i].out![q], -1];
        const d = infos[i].out![0] * infos[i].location![0] + infos[i].out![1] * infos[i].location![1] + infos[i].out![2] * infos[i].location![2];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) m[r][c] += row[r] * row[c];
          rhs[r] += row[r] * d;
        }
      }
      const solution = solve3(m, rhs);
      if (!solution) continue;
      const apothem = solution[2];
      const lows: number[] = [];
      const highs: number[] = [];
      for (const i of ring) {
        const box = kernel.getBoundingBox(faces[i]);
        lows.push([box.xmin, box.ymin, box.zmin][axis]);
        highs.push([box.xmax, box.ymax, box.zmax][axis]);
      }
      if (Math.max(...lows) - Math.min(...lows) > 1e-4 || Math.max(...highs) - Math.min(...highs) > 1e-4) continue;
      found.push({ axis, across: [solution[0], solution[1]], radius: Math.abs(apothem) / Math.cos(Math.PI / n), lo: lows[0], hi: highs[0], hole: apothem > 0, members: ring, sides: n });
    }
  }
  return found;
}

/** A body of revolution: external round faces around one axis line that fill the part's width. */
function readTurned(rounds: Round[], bounds: { min: Vec3; max: Vec3 }): TurnedData | undefined {
  const bosses = rounds.filter((round) => !round.hole && round.sides === undefined);
  if (!bosses.length) return undefined;
  const lines = new Map<string, Round[]>();
  for (const round of bosses) {
    const key = `${round.axis}|${quantum(round.across[0])}|${quantum(round.across[1])}`;
    lines.set(key, [...(lines.get(key) ?? []), round]);
  }
  const [steps] = [...lines.values()].sort((a, b) => b.length - a.length);
  if (steps.length > 12 || bosses.length !== steps.length) return undefined;
  const axis = steps[0].axis;
  const [p, q] = others(axis);
  const widest = Math.max(...steps.map((step) => 2 * step.radius));
  const fits = (index: Axis, centre: number) => Math.abs(bounds.max[index] - bounds.min[index] - widest) < 1e-3 && Math.abs((bounds.max[index] + bounds.min[index]) / 2 - centre) < 1e-3;
  if (!fits(p, steps[0].across[0]) || !fits(q, steps[0].across[1])) return undefined;
  const covered = steps.reduce((sum, step) => sum + (step.hi - step.lo), 0);
  if (covered < 0.5 * (bounds.max[axis] - bounds.min[axis])) return undefined;
  return { axis, at: [steps[0].across[0], steps[0].across[1]], steps: steps.sort((a, b) => a.lo - b.lo).map((step) => ({ from: step.lo, to: step.hi, diameter: 2 * step.radius })) };
}

/**
 * A section through the axis of a hole (F35): the solid is cut by a box over the side nearer the viewer, the flat faces that lie in the cut are
 * the area to hatch, and the visible edges of what is left are the view. Returns undefined when the cut makes nothing.
 */
export function makeSection(kernel: OcctKernel, shape: ShapeHandle, hole: HoleData, bounds: { min: Vec3; max: Vec3 }, deflection: number): SectionData | undefined {
  const mark = kernel.checkpoint();
  try {
    // A hole along z or x is cut across y and seen from the front; a hole along y is cut across x and seen from the right.
    const cutAxis: Axis = hole.axis === 1 ? 0 : 1;
    const at = hole.at[cutAxis];
    const looking: 1 | -1 = cutAxis === 1 ? 1 : -1;
    const margin = 1;
    const low: Vec3 = [bounds.min[0] - margin, bounds.min[1] - margin, bounds.min[2] - margin];
    const high: Vec3 = [bounds.max[0] + margin, bounds.max[1] + margin, bounds.max[2] + margin];
    // Remove the half nearer the viewer: y below the plane for the front, x above it for the right.
    if (cutAxis === 1) high[1] = at;
    else low[0] = at;
    const cut = kernel.cut(shape, kernel.makeBoxFromCorners(point(low), point(high)));
    const frame = cutAxis === 1 ? viewFrames.front : viewFrames.right;
    const view = projectView(kernel, cut, 'section', frame, deflection, false);
    const outlines: Vec2[][] = [];
    let area = 0;
    for (const face of kernel.getSubShapes(cut, 'face')) {
      const data = kernel.surfaceData(face);
      if (data.kind !== 'plane') continue;
      const normal = [data.normal.x, data.normal.y, data.normal.z];
      if (Math.abs(Math.abs(normal[cutAxis]) - 1) > 1e-6 || Math.abs([data.location.x, data.location.y, data.location.z][cutAxis] - at) > 1e-4) continue;
      area += kernel.getSurfaceArea(face);
      const wire = kernel.wireframe(face, deflection);
      for (let g = 0; g + 2 < wire.edgeGroups.length; g += 3) {
        const start = wire.edgeGroups[g];
        const length = wire.edgeGroups[g + 1];
        const line: Vec2[] = [];
        for (let i = start; i + 2 < start + length; i += 3) {
          const point3 = { x: wire.points[i], y: wire.points[i + 1], z: wire.points[i + 2] };
          line.push(cutAxis === 1 ? [point3.x, point3.z] : [point3.y, point3.z]);
        }
        if (line.length >= 2) outlines.push(line);
      }
    }
    if (!outlines.length) return undefined;
    return { label: 'A', axis: cutAxis, at, lineIn: hole.axis === 0 ? 'right' : hole.axis === 1 ? 'front' : 'top', looking, view, outlines, area };
  } catch {
    return undefined;
  } finally {
    kernel.releaseSince(mark);
  }
}

export interface DrawInput {
  names: string[];
  quantity: number;
  mesh: PartMesh;
  /** The exact solid, when the part has one. */
  shape?: ShapeHandle;
  imported: boolean;
}

/** Everything a sheet needs of one part, read from its solid (or from its mesh when it has none). Holds no handles afterwards. */
export function drawPart(kernel: OcctKernel, input: DrawInput): PartDrawing {
  const { mesh } = input;
  const bounds = { min: mesh.bounds.min, max: mesh.bounds.max };
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const deflection = Math.min(0.05, Math.max(0.003, size / 1500));
  const base = { names: input.names, quantity: input.quantity, imported: input.imported, bounds };
  if (!input.shape || mesh.quality === 'faceted') {
    return { ...base, quality: 'faceted', reason: mesh.reason, views: meshViews(mesh), holes: [], notes: [`Faceted part${mesh.reason ? ` (${mesh.reason})` : ''}: its curved surfaces are flat facets, so only its overall size is dimensioned and its holes are not read.`] };
  }
  const mark = kernel.checkpoint();
  try {
    const views = (['front', 'top', 'right', 'iso'] as const).map((name) => projectView(kernel, input.shape!, name, viewFrames[name], deflection));
    const features = readFeatures(kernel, input.shape, Boolean(mesh.flatRounds?.length), bounds);
    const first = features.holes.find((hole) => !hole.through || hole.bore);
    const section = first ? makeSection(kernel, input.shape, first, bounds, deflection) : undefined;
    return { ...base, quality: 'exact', views, holes: features.holes, turned: features.turned, section, notes: features.notes };
  } finally {
    kernel.releaseSince(mark);
  }
}

import { clampJoint, invert, movingJoints, multiply, structureOf, transformBounds, turnsFully, solvePose, type AssemblySpec, type Matrix } from './engine/assembly.ts';
import { moveJoint } from './engine/kinematics.ts';
import type { PartMesh, Pose, Vec3 } from './engine/protocol.ts';
import { bvhOf, type Bvh } from './picking.ts';

/**
 * Collision detection for an assembly, on the preview meshes. Pure arithmetic on numbers, like picking.ts, so the page and the tests
 * use the same code.
 *
 * Stage 1 compares the boxes of the parts in the world. Stage 2 walks the bounding volume hierarchies of the two meshes together and
 * tests triangles against triangles. A pair of triangles counts only when each has vertices clearly on both sides of the other's
 * plane, so faces that lie against each other, and edges and corners that touch, are not collisions. A part wholly inside another has
 * no crossing triangles, so a point just inside each body is tested by ray parity. Stage 3, which confirms a pair with the exact
 * solids, is in the worker (build.ts, collide).
 */

/** Two parts that share volume. */
export interface PairHit {
  /** Indices into assembly.parts, a before b. */
  a: number;
  b: number;
  /** crossing: their surfaces cross. nested: one lies wholly inside the other and the surfaces do not meet. */
  kind: 'crossing' | 'nested';
  /** Where the surfaces cross, in world coordinates, as x, y, z, x, y, z for each line. Empty when nested or when it was not asked for. */
  segments: Float32Array;
}

/** Fewest the lines of one pair that are kept, so that a deep overlap does not cost more to draw than to find. */
export const maxSegments = 200;
/** A vertex this close to the other triangle's plane (as a share of the parts' size) is on the plane, not on a side of it. */
const sideTolerance = 1e-6;
/** Boxes that overlap by less than this, in mm, in any direction belong to parts that only touch. */
export const touchDepth = 1e-3;
/** The most bodies of one part that are tested for lying inside another part. */
const maxBodies = 32;

type Box = { min: Vec3; max: Vec3 };

// ---------------------------------------------------------------------------------------------------------------------------------
// Triangles

/**
 * The part of the line where a triangle meets a plane, as the lowest and highest position along `along`, with the points. `d` is each
 * vertex's distance from the plane. Writes [low, high, lowx, lowy, lowz, highx, highy, highz] into `into`.
 */
function cut(t: ArrayLike<number>, d: number[], along: Vec3, eps: number, into: Float64Array) {
  let low = Infinity;
  let high = -Infinity;
  const consider = (x: number, y: number, z: number) => {
    const at = x * along[0] + y * along[1] + z * along[2];
    if (at < low) {
      low = at;
      into[2] = x;
      into[3] = y;
      into[4] = z;
    }
    if (at > high) {
      high = at;
      into[5] = x;
      into[6] = y;
      into[7] = z;
    }
  };
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if (Math.abs(d[i]) <= eps) consider(t[i * 3], t[i * 3 + 1], t[i * 3 + 2]);
    if (d[i] * d[j] < 0) {
      const s = d[i] / (d[i] - d[j]);
      consider(t[i * 3] + (t[j * 3] - t[i * 3]) * s, t[i * 3 + 1] + (t[j * 3 + 1] - t[i * 3 + 1]) * s, t[i * 3 + 2] + (t[j * 3 + 2] - t[i * 3 + 2]) * s);
    }
  }
  into[0] = low;
  into[1] = high;
}

/**
 * Two triangles in one plane. The bodies they belong to overlap there when both bodies lie on the same side of the plane, which
 * is when the outward normals point the same way, and the triangles share area. The lines written are the edges of that shared area.
 */
function coplanarOverlap(a: ArrayLike<number>, b: ArrayLike<number>, na: Vec3, nb: Vec3, eps: number, out: number[]) {
  if (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] <= 0) return false;
  let polygon: Vec3[] = [[b[0], b[1], b[2]], [b[3], b[4], b[5]], [b[6], b[7], b[8]]];
  for (let i = 0; i < 3; i++) {
    const p = [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
    const q = [a[((i + 1) % 3) * 3], a[((i + 1) % 3) * 3 + 1], a[((i + 1) % 3) * 3 + 2]];
    const r = [a[((i + 2) % 3) * 3], a[((i + 2) % 3) * 3 + 1], a[((i + 2) % 3) * 3 + 2]];
    const edge = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    // The side of this edge, in the plane, that the triangle is on.
    const side = [na[1] * edge[2] - na[2] * edge[1], na[2] * edge[0] - na[0] * edge[2], na[0] * edge[1] - na[1] * edge[0]];
    const sign = side[0] * (r[0] - p[0]) + side[1] * (r[1] - p[1]) + side[2] * (r[2] - p[2]) >= 0 ? 1 : -1;
    const level = (x: Vec3) => sign * (side[0] * (x[0] - p[0]) + side[1] * (x[1] - p[1]) + side[2] * (x[2] - p[2]));
    const kept: Vec3[] = [];
    for (let j = 0; j < polygon.length; j++) {
      const from = polygon[j];
      const to = polygon[(j + 1) % polygon.length];
      const [lf, lt] = [level(from), level(to)];
      if (lf >= 0) kept.push(from);
      if ((lf >= 0) !== (lt >= 0)) {
        const s = lf / (lf - lt);
        kept.push([from[0] + (to[0] - from[0]) * s, from[1] + (to[1] - from[1]) * s, from[2] + (to[2] - from[2]) * s]);
      }
    }
    polygon = kept;
    if (polygon.length < 3) return false;
  }
  let [cx, cy, cz] = [0, 0, 0];
  for (let j = 1; j + 1 < polygon.length; j++) {
    const u = [polygon[j][0] - polygon[0][0], polygon[j][1] - polygon[0][1], polygon[j][2] - polygon[0][2]];
    const v = [polygon[j + 1][0] - polygon[0][0], polygon[j + 1][1] - polygon[0][1], polygon[j + 1][2] - polygon[0][2]];
    cx += u[1] * v[2] - u[2] * v[1];
    cy += u[2] * v[0] - u[0] * v[2];
    cz += u[0] * v[1] - u[1] * v[0];
  }
  // Shared area has to be larger than a square 100 times the side tolerance across, or it is the edge of a touching face.
  if (Math.hypot(cx, cy, cz) / 2 <= (100 * eps) ** 2) return false;
  for (let j = 0; j < polygon.length; j++) out.push(...polygon[j], ...polygon[(j + 1) % polygon.length]);
  return true;
}

const spanA = new Float64Array(8);
const spanB = new Float64Array(8);
const distances = [0, 0, 0];
const otherDistances = [0, 0, 0];

/**
 * Whether two triangles (nine numbers each) properly cross. When they do, the ends of the line where they cross are written to `out`.
 * Triangles that lie in one plane, or that only touch, do not cross.
 */
export function trianglesCross(a: ArrayLike<number>, b: ArrayLike<number>, eps: number, out: number[]): boolean {
  const e1x = a[3] - a[0];
  const e1y = a[4] - a[1];
  const e1z = a[5] - a[2];
  const e2x = a[6] - a[0];
  const e2y = a[7] - a[1];
  const e2z = a[8] - a[2];
  let nax = e1y * e2z - e1z * e2y;
  let nay = e1z * e2x - e1x * e2z;
  let naz = e1x * e2y - e1y * e2x;
  const la = Math.sqrt(nax * nax + nay * nay + naz * naz);
  if (la < 1e-18) return false;
  nax /= la;
  nay /= la;
  naz /= la;
  let high = -Infinity;
  let low = Infinity;
  for (let k = 0; k < 3; k++) {
    const d = nax * (b[k * 3] - a[0]) + nay * (b[k * 3 + 1] - a[1]) + naz * (b[k * 3 + 2] - a[2]);
    distances[k] = d;
    if (d > high) high = d;
    if (d < low) low = d;
  }
  const f1x = b[3] - b[0];
  const f1y = b[4] - b[1];
  const f1z = b[5] - b[2];
  const f2x = b[6] - b[0];
  const f2y = b[7] - b[1];
  const f2z = b[8] - b[2];
  let nbx = f1y * f2z - f1z * f2y;
  let nby = f1z * f2x - f1x * f2z;
  let nbz = f1x * f2y - f1y * f2x;
  const lb = Math.sqrt(nbx * nbx + nby * nby + nbz * nbz);
  if (lb < 1e-18) return false;
  nbx /= lb;
  nby /= lb;
  nbz /= lb;
  // In one plane: the bodies overlap if they are on the same side of it.
  if (high <= eps && low >= -eps) return coplanarOverlap(a, b, [nax, nay, naz], [nbx, nby, nbz], eps, out);
  // b must have vertices clearly on both sides of a's plane.
  if (!(high > eps && low < -eps)) return false;
  high = -Infinity;
  low = Infinity;
  for (let k = 0; k < 3; k++) {
    const d = nbx * (a[k * 3] - b[0]) + nby * (a[k * 3 + 1] - b[1]) + nbz * (a[k * 3 + 2] - b[2]);
    otherDistances[k] = d;
    if (d > high) high = d;
    if (d < low) low = d;
  }
  if (!(high > eps && low < -eps)) return false;

  // The planes meet in a line along na x nb.
  let dx = nay * nbz - naz * nby;
  let dy = naz * nbx - nax * nbz;
  let dz = nax * nby - nay * nbx;
  const ld = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (ld < 1e-12) return false;
  dx /= ld;
  dy /= ld;
  dz /= ld;
  const along: Vec3 = [dx, dy, dz];
  cut(a, otherDistances, along, eps, spanA);
  cut(b, distances, along, eps, spanB);
  const start = Math.max(spanA[0], spanB[0]);
  const end = Math.min(spanA[1], spanB[1]);
  if (!(end - start > eps)) return false;
  const lowFrom = spanA[0] >= spanB[0] ? spanA : spanB;
  const highFrom = spanA[1] <= spanB[1] ? spanA : spanB;
  out.push(lowFrom[2], lowFrom[3], lowFrom[4], highFrom[5], highFrom[6], highFrom[7]);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Meshes

const bodyCache = new WeakMap<PartMesh, Vec3[]>();
const reachCache = new WeakMap<PartMesh, number>();

/** The largest coordinate or span of a mesh, which sets how close to a plane a vertex has to be to count as on it. */
function reachOf(mesh: PartMesh) {
  let reach = reachCache.get(mesh);
  if (reach === undefined) {
    const { min, max } = mesh.bounds;
    reach = Math.max(1e-6, ...min.map(Math.abs), ...max.map(Math.abs), Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    reachCache.set(mesh, reach);
  }
  return reach;
}

/**
 * A point just inside each separate body of a mesh (up to maxBodies), in the mesh's own coordinates. Bodies are found by welding
 * the vertices that sit at one place and joining the triangles that share a welded vertex. The point is the middle of the body's
 * largest triangle, moved a little against its outward normal.
 */
export function bodyPoints(mesh: PartMesh): Vec3[] {
  const cached = bodyCache.get(mesh);
  if (cached) return cached;
  const { positions, indices, bounds } = mesh;
  const size = Math.max(Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]), 1e-6);
  const cell = size * 1e-5;
  const welded = new Map<string, number>();
  const ids = new Int32Array(positions.length / 3);
  for (let v = 0; v < ids.length; v++) {
    const key = `${Math.round(positions[v * 3] / cell)},${Math.round(positions[v * 3 + 1] / cell)},${Math.round(positions[v * 3 + 2] / cell)}`;
    let id = welded.get(key);
    if (id === undefined) welded.set(key, id = welded.size);
    ids[v] = id;
  }
  const parent = Int32Array.from({ length: welded.size }, (_, i) => i);
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const triangles = indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const a = find(ids[indices[t * 3]]);
    const b = find(ids[indices[t * 3 + 1]]);
    const c = find(ids[indices[t * 3 + 2]]);
    parent[b] = a;
    parent[find(c)] = find(a);
  }
  const best = new Map<number, { t: number; area: number }>();
  for (let t = 0; t < triangles; t++) {
    const [i, j, k] = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
    const ux = positions[j] - positions[i];
    const uy = positions[j + 1] - positions[i + 1];
    const uz = positions[j + 2] - positions[i + 2];
    const vx = positions[k] - positions[i];
    const vy = positions[k + 1] - positions[i + 1];
    const vz = positions[k + 2] - positions[i + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const root = find(ids[indices[t * 3]]);
    const was = best.get(root);
    if (!was || area > was.area) best.set(root, { t, area });
  }
  const nudge = Math.max(size * 1e-4, 1e-4);
  const points: Vec3[] = [];
  for (const { t, area } of best.values()) {
    if (area < 1e-18 || points.length >= maxBodies) continue;
    const [i, j, k] = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
    const ux = positions[j] - positions[i];
    const uy = positions[j + 1] - positions[i + 1];
    const uz = positions[j + 2] - positions[i + 2];
    const vx = positions[k] - positions[i];
    const vy = positions[k + 1] - positions[i + 1];
    const vz = positions[k + 2] - positions[i + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...n);
    points.push([0, 1, 2].map((axis) => (positions[i + axis] + positions[j + axis] + positions[k + axis]) / 3 - (n[axis] / length) * nudge) as Vec3);
  }
  bodyCache.set(mesh, points);
  return points;
}

const rayStack = new Int32Array(256);
const rays: Vec3[] = [[0.7071, 0.4143, 0.5707], [-0.3101, 0.8267, 0.4701], [0.2203, -0.5509, -0.8031]].map((v) => {
  const length = Math.hypot(...v);
  return v.map((c) => c / length) as Vec3;
});

/** How many triangles a ray from `o` along `d` crosses, ahead of its origin. */
function crossingsAlong(mesh: PartMesh, tree: Bvh, o: Vec3, d: Vec3) {
  const { box, link, count, order } = tree;
  const { positions, indices } = mesh;
  const inv = d.map((c) => 1 / (Math.abs(c) < 1e-300 ? 1e-300 : c));
  let hits = 0;
  let top = 0;
  rayStack[top++] = 0;
  while (top) {
    const node = rayStack[--top];
    let near = 0;
    let far = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const p = (box[node * 6 + axis] - o[axis]) * inv[axis];
      const q = (box[node * 6 + axis + 3] - o[axis]) * inv[axis];
      near = Math.max(near, Math.min(p, q));
      far = Math.min(far, Math.max(p, q));
    }
    if (near > far * (1 + 1e-9) + 1e-9) continue;
    if (!count[node]) {
      rayStack[top++] = link[node];
      rayStack[top++] = node + 1;
      continue;
    }
    for (let k = link[node]; k < link[node] + count[node]; k++) {
      const t = order[k];
      const [ia, ib, ic] = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
      const e1x = positions[ib] - positions[ia];
      const e1y = positions[ib + 1] - positions[ia + 1];
      const e1z = positions[ib + 2] - positions[ia + 2];
      const e2x = positions[ic] - positions[ia];
      const e2y = positions[ic + 1] - positions[ia + 1];
      const e2z = positions[ic + 2] - positions[ia + 2];
      const px = d[1] * e2z - d[2] * e2y;
      const py = d[2] * e2x - d[0] * e2z;
      const pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-18) continue;
      const sx = o[0] - positions[ia];
      const sy = o[1] - positions[ia + 1];
      const sz = o[2] - positions[ia + 2];
      const u = (sx * px + sy * py + sz * pz) / det;
      if (u < 0 || u >= 1) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
      if (v < 0 || u + v >= 1) continue;
      if ((e2x * qx + e2y * qy + e2z * qz) / det > 1e-12) hits++;
    }
  }
  return hits;
}

/** Whether a point (in the mesh's coordinates) lies inside a closed mesh. Three rays vote, so one ray through an edge cannot decide it. */
function isInside(mesh: PartMesh, p: Vec3) {
  const tree = bvhOf(mesh);
  if (!tree.count.length) return false;
  let odd = 0;
  for (const ray of rays) odd += crossingsAlong(mesh, tree, p, ray) & 1;
  return odd >= 2;
}

function through(m: Matrix, p: Vec3): Vec3 {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}

const within = (box: { min: Vec3; max: Vec3 }, p: Vec3) => [0, 1, 2].every((k) => p[k] >= box.min[k] && p[k] <= box.max[k]);

// ---------------------------------------------------------------------------------------------------------------------------------
// One pair

interface LocalHit {
  kind: 'crossing' | 'nested';
  /** In the coordinates of the pair's first part. */
  segments: number[];
  /** True when every line was collected, not only the first. */
  full: boolean;
}

const stack = new Int32Array(2048);
const triangleA = new Float64Array(9);
const triangleB = new Float64Array(9);
const leafTriangles = new Float64Array(9 * 64);
const boxOfB = new Float64Array(6);

/** The box of node `n` of tree `t`, after the matrix, as the box around its eight corners. */
function boxThrough(tree: Bvh, n: number, m: Matrix, into: Float64Array) {
  const b = n * 6;
  const cx = (tree.box[b] + tree.box[b + 3]) / 2;
  const cy = (tree.box[b + 1] + tree.box[b + 4]) / 2;
  const cz = (tree.box[b + 2] + tree.box[b + 5]) / 2;
  const hx = (tree.box[b + 3] - tree.box[b]) / 2;
  const hy = (tree.box[b + 4] - tree.box[b + 1]) / 2;
  const hz = (tree.box[b + 5] - tree.box[b + 2]) / 2;
  for (let axis = 0; axis < 3; axis++) {
    const r = axis * 4;
    const centre = m[r] * cx + m[r + 1] * cy + m[r + 2] * cz + m[r + 3];
    const reach = Math.abs(m[r]) * hx + Math.abs(m[r + 1]) * hy + Math.abs(m[r + 2]) * hz;
    into[axis] = centre - reach;
    into[axis + 3] = centre + reach;
  }
}

/** Whether the meshes of two parts overlap, with `rel` taking the second's coordinates to the first's. */
export function meshesOverlap(a: PartMesh, b: PartMesh, rel: Matrix, collect: boolean, counters?: { triangles: number; leaves?: number; nodes?: number; planar?: number; crossed?: number }): LocalHit | undefined {
  const ta = bvhOf(a);
  const tb = bvhOf(b);
  if (!ta.count.length || !tb.count.length) return undefined;
  const eps = sideTolerance * Math.max(reachOf(a), reachOf(b));
  const segments: number[] = [];
  const one: number[] = [];
  let top = 0;
  stack[top++] = 0;
  stack[top++] = 0;
  while (top) {
    const nb = stack[--top];
    const na = stack[--top];
    boxThrough(tb, nb, rel, boxOfB);
    if (counters?.nodes !== undefined) counters.nodes++;
    let apart = false;
    for (let axis = 0; axis < 3; axis++) {
      if (ta.box[na * 6 + axis] > boxOfB[axis + 3] + eps || boxOfB[axis] > ta.box[na * 6 + axis + 3] + eps) apart = true;
    }
    if (apart) continue;
    const leafA = ta.count[na] > 0;
    const leafB = tb.count[nb] > 0;
    if (leafA && leafB) {
      // The triangles of b's leaf in a's coordinates, once for the leaf.
      if (counters?.leaves !== undefined) counters.leaves++;
      const countB = tb.count[nb];
      for (let j = 0; j < countB; j++) {
        const u = tb.order[tb.link[nb] + j];
        for (let k = 0; k < 3; k++) {
          const v = b.indices[u * 3 + k] * 3;
          const x = b.positions[v];
          const y = b.positions[v + 1];
          const z = b.positions[v + 2];
          leafTriangles[j * 9 + k * 3] = rel[0] * x + rel[1] * y + rel[2] * z + rel[3];
          leafTriangles[j * 9 + k * 3 + 1] = rel[4] * x + rel[5] * y + rel[6] * z + rel[7];
          leafTriangles[j * 9 + k * 3 + 2] = rel[8] * x + rel[9] * y + rel[10] * z + rel[11];
        }
      }
      for (let i = ta.link[na]; i < ta.link[na] + ta.count[na]; i++) {
        const t = ta.order[i];
        for (let k = 0; k < 3; k++) {
          const v = a.indices[t * 3 + k] * 3;
          triangleA[k * 3] = a.positions[v];
          triangleA[k * 3 + 1] = a.positions[v + 1];
          triangleA[k * 3 + 2] = a.positions[v + 2];
        }
        // a's plane, unnormalised: a b triangle with all three vertices on one side of it cannot cross or lie in it.
        const e1x = triangleA[3] - triangleA[0];
        const e1y = triangleA[4] - triangleA[1];
        const e1z = triangleA[5] - triangleA[2];
        const e2x = triangleA[6] - triangleA[0];
        const e2y = triangleA[7] - triangleA[1];
        const e2z = triangleA[8] - triangleA[2];
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const reachSide = eps * Math.sqrt(nx * nx + ny * ny + nz * nz);
        for (let j = 0; j < countB; j++) {
          if (counters) counters.triangles++;
          const o = j * 9;
          const d0 = nx * (leafTriangles[o] - triangleA[0]) + ny * (leafTriangles[o + 1] - triangleA[1]) + nz * (leafTriangles[o + 2] - triangleA[2]);
          const d1 = nx * (leafTriangles[o + 3] - triangleA[0]) + ny * (leafTriangles[o + 4] - triangleA[1]) + nz * (leafTriangles[o + 5] - triangleA[2]);
          const d2 = nx * (leafTriangles[o + 6] - triangleA[0]) + ny * (leafTriangles[o + 7] - triangleA[1]) + nz * (leafTriangles[o + 8] - triangleA[2]);
          // All clearly on one side: neither a crossing nor in one plane.
          if ((d0 > reachSide && d1 > reachSide && d2 > reachSide) || (d0 < -reachSide && d1 < -reachSide && d2 < -reachSide)) continue;
          if (d0 <= reachSide && d1 <= reachSide && d2 <= reachSide && d0 >= -reachSide && d1 >= -reachSide && d2 >= -reachSide) {
            // In one plane: only facing the same way do the bodies overlap there. Faces that lie against each other are the common case.
            const f1x = leafTriangles[o + 3] - leafTriangles[o];
            const f1y = leafTriangles[o + 4] - leafTriangles[o + 1];
            const f1z = leafTriangles[o + 5] - leafTriangles[o + 2];
            const f2x = leafTriangles[o + 6] - leafTriangles[o];
            const f2y = leafTriangles[o + 7] - leafTriangles[o + 1];
            const f2z = leafTriangles[o + 8] - leafTriangles[o + 2];
            if (counters?.planar !== undefined) counters.planar++;
            if (nx * (f1y * f2z - f1z * f2y) + ny * (f1z * f2x - f1x * f2z) + nz * (f1x * f2y - f1y * f2x) <= 0) continue;
          }
          if (counters?.crossed !== undefined) counters.crossed++;
          for (let k = 0; k < 9; k++) triangleB[k] = leafTriangles[o + k];
          one.length = 0;
          if (!trianglesCross(triangleA, triangleB, eps, one)) continue;
          if (!collect) return { kind: 'crossing', segments: one, full: false };
          segments.push(...one);
          if (segments.length >= maxSegments * 6) return { kind: 'crossing', segments, full: true };
        }
      }
      continue;
    }
    const sizeA = (ta.box[na * 6 + 3] - ta.box[na * 6]) + (ta.box[na * 6 + 4] - ta.box[na * 6 + 1]) + (ta.box[na * 6 + 5] - ta.box[na * 6 + 2]);
    const sizeB = (boxOfB[3] - boxOfB[0]) + (boxOfB[4] - boxOfB[1]) + (boxOfB[5] - boxOfB[2]);
    if (!leafA && (leafB || sizeA >= sizeB)) {
      stack[top++] = na + 1;
      stack[top++] = nb;
      stack[top++] = ta.link[na];
      stack[top++] = nb;
    } else {
      stack[top++] = na;
      stack[top++] = nb + 1;
      stack[top++] = na;
      stack[top++] = tb.link[nb];
    }
  }
  if (segments.length) return { kind: 'crossing', segments, full: true };

  // No surface crosses another. One may still lie wholly inside the other.
  const back = invert(rel);
  for (const point of bodyPoints(b)) {
    const inA = through(rel, point);
    if (within(a.bounds, inA) && isInside(a, inA)) return { kind: 'nested', segments: [], full: true };
  }
  for (const point of bodyPoints(a)) {
    const inB = through(back, point);
    if (within(b.bounds, inB) && isInside(b, inB)) return { kind: 'nested', segments: [], full: true };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// An assembly

/** The groups of parts that never move relative to each other: those joined by fixed joints, and the parts that no joint carries. */
export function rigidGroups(assembly: AssemblySpec): number[] {
  const parent = assembly.parts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const index = new Map(assembly.parts.map((part, i) => [part.name, i]));
  for (const joint of assembly.joints) {
    if (joint.type === 'fixed') join(index.get(joint.parent)!, index.get(joint.child)!);
  }
  const { roots } = structureOf(assembly);
  for (const root of roots.slice(1)) join(roots[0], root);
  return assembly.parts.map((_, i) => find(i));
}

const sameMatrix = (a: Matrix, b: Matrix) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);

export class CollisionChecker {
  readonly assembly: AssemblySpec;
  readonly meshes: PartMesh[];
  /** The pairs that are checked: every pair of parts except those that allow_overlap() names. */
  readonly pairs: [number, number][];
  readonly groups: number[];
  /** What the work has been: pairs read from the cache, and pairs and triangles tested. */
  readonly stats = { reused: 0, narrow: 0, triangles: 0 };
  /** The same, for each pair, by key (see pairKey). For tests and probes. */
  readonly byPair = new Map<number, { narrow: number; triangles: number; nodes: number; leaves: number; planar: number; crossed: number }>();
  readonly #cache = new Map<number, { rel: Matrix; hit: LocalHit | undefined }>();
  /** The step of a sweep of each joint, measured the first time a move of that joint asks for it. */
  readonly steps = new Map<string, number>();

  constructor(assembly: AssemblySpec, meshes: PartMesh[]) {
    this.assembly = assembly;
    this.meshes = meshes;
    this.groups = rigidGroups(assembly);
    const index = new Map(assembly.parts.map((part, i) => [part.name, i]));
    const allowed = new Set(assembly.allowed.map(([x, y]) => {
      const [a, b] = [index.get(x)!, index.get(y)!];
      return a < b ? a * assembly.parts.length + b : b * assembly.parts.length + a;
    }));
    this.pairs = [];
    for (let a = 0; a < assembly.parts.length; a++) {
      for (let b = a + 1; b < assembly.parts.length; b++) if (!allowed.has(a * assembly.parts.length + b)) this.pairs.push([a, b]);
    }
  }

  /** The box of every part in the world. */
  boxes(matrices: Matrix[]): Box[] {
    return this.meshes.map((mesh, i) => {
      const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      transformBounds(mesh.bounds, matrices[i], box);
      return box;
    });
  }

  /** Whether two parts collide, or undefined. The lines where their surfaces cross are in `segments` when `collect` is set. */
  pair(a: number, b: number, matrices: Matrix[], collect = false): PairHit | undefined {
    const rel = multiply(invert(matrices[a]), matrices[b]);
    const key = a * this.assembly.parts.length + b;
    const cached = this.#cache.get(key);
    let hit: LocalHit | undefined;
    if (cached && sameMatrix(cached.rel, rel) && (!collect || !cached.hit || cached.hit.full)) {
      this.stats.reused++;
      hit = cached.hit;
    } else {
      this.stats.narrow++;
      const counters = { triangles: 0, leaves: 0, nodes: 0, planar: 0, crossed: 0 };
      hit = meshesOverlap(this.meshes[a], this.meshes[b], rel, collect, counters);
      this.stats.triangles += counters.triangles;
      const own = this.byPair.get(key) ?? { narrow: 0, triangles: 0, nodes: 0, leaves: 0, planar: 0, crossed: 0 };
      own.narrow++;
      own.triangles += counters.triangles;
      own.nodes += counters.nodes;
      own.leaves += counters.leaves;
      own.planar += counters.planar;
      own.crossed += counters.crossed;
      this.byPair.set(key, own);
      this.#cache.set(key, { rel, hit });
    }
    if (!hit) return undefined;
    const world = new Float32Array(collect ? hit.segments.length : 0);
    if (collect) {
      for (let s = 0; s < hit.segments.length; s += 3) {
        const p = through(matrices[a], [hit.segments[s], hit.segments[s + 1], hit.segments[s + 2]]);
        world[s] = p[0];
        world[s + 1] = p[1];
        world[s + 2] = p[2];
      }
    }
    return { a, b, kind: hit.kind, segments: world };
  }

  /** Every pair that collides in a pose. Without `collect`, a pair stops at its first crossing, which is faster. */
  check(matrices: Matrix[], collect = true): PairHit[] {
    const boxes = this.boxes(matrices);
    const hits: PairHit[] = [];
    for (const [a, b] of this.pairs) {
      const x = boxes[a];
      const y = boxes[b];
      // Parts that overlap by less than a micrometre in any direction only touch.
      if (x.min[0] + touchDepth >= y.max[0] || y.min[0] + touchDepth >= x.max[0] || x.min[1] + touchDepth >= y.max[1] || y.min[1] + touchDepth >= x.max[1] || x.min[2] + touchDepth >= y.max[2] || y.min[2] + touchDepth >= x.max[2]) continue;
      const hit = this.pair(a, b, matrices, collect);
      if (hit) hits.push(hit);
    }
    return hits;
  }
}

/** The pair as one number, for sets. */
export const pairKey = (a: number, b: number, count: number) => (a < b ? a * count + b : b * count + a);

// ---------------------------------------------------------------------------------------------------------------------------------
// Motion

/** The value at which a hinge or slider is tried, how far it is to the end of its travel, and the unit. */
export function travelOf(assembly: AssemblySpec, name: string) {
  const joint = assembly.joints.find((item) => item.name === name)!;
  const [low, high] = joint.limits;
  return { joint, low, high: turnsFully(joint) ? low + 360 : high, unit: joint.type === 'hinge' ? '°' as const : 'mm' as const, tolerance: joint.type === 'hinge' ? 0.01 : 0.001 };
}

/** The corners of a part's box, in its own coordinates. */
function corners(mesh: PartMesh): Vec3[] {
  const { min, max } = mesh.bounds;
  return Array.from({ length: 8 }, (_, c) => [c & 1 ? max[0] : min[0], c & 2 ? max[1] : min[1], c & 4 ? max[2] : min[2]] as Vec3);
}

/** The farthest any point of any part moves for a small move of the joint, per unit of the joint. */
function rate(checker: CollisionChecker, pose: Pose, name: string, value: number, small: number) {
  const { assembly } = checker;
  const first = moveJoint(assembly, pose, name, value);
  const second = moveJoint(assembly, first.pose, name, value + small);
  const from = solvePose(assembly, first.pose);
  const to = solvePose(assembly, second.pose);
  const moved = Math.abs((second.pose[name] ?? value + small) - (first.pose[name] ?? value));
  if (moved < small * 1e-3) return 0;
  let farthest = 0;
  checker.meshes.forEach((mesh, i) => {
    for (const corner of corners(mesh)) {
      const [p, q] = [through(from[i], corner), through(to[i], corner)];
      farthest = Math.max(farthest, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
  });
  return farthest / moved;
}

/** The most a point may move between two samples of a sweep, in mm. */
export const sampleMove = 0.5;
/** An exact overlap under this many mm³ is two parts that touch. The lowest that was real in the v3 machine's sweeps was 0.0128 (F41). */
export const overlapFloor = 0.01;
const maxSamples = 3600;

/** The step in joint units that keeps every point of every part within sampleMove of its last place, never over 1 degree for a hinge. */
export function sweepStep(checker: CollisionChecker, pose: Pose, name: string) {
  const { joint, low, high } = travelOf(checker.assembly, name);
  const span = high - low;
  const small = joint.type === 'hinge' ? 0.5 : Math.max(span / 400, 1e-3);
  let fastest = 0;
  for (let k = 0; k < 9; k++) fastest = Math.max(fastest, rate(checker, pose, name, Math.min(high - small, low + (span * k) / 8), small));
  const wanted = fastest > 0 ? sampleMove / fastest : Infinity;
  return Math.max(span / maxSamples, Math.min(wanted, joint.type === 'hinge' ? 1 : span / 20));
}

/** The keys of the pairs that collide in a pose, found by the quick test. */
function collidingIn(checker: CollisionChecker, pose: Pose): Set<number> {
  const count = checker.assembly.parts.length;
  return new Set(checker.check(solvePose(checker.assembly, pose), false).map((hit) => pairKey(hit.a, hit.b, count)));
}

/** One stretch of a joint's travel in which two parts collide. */
export interface MotionInterval {
  a: number;
  b: number;
  joint: string;
  /** The values of the joint where the overlap starts and ends, to the sweep's tolerance. */
  from: number;
  to: number;
  /** True when the overlap is already there at the start of the travel, or still there at its end. */
  openFrom: boolean;
  openTo: boolean;
  /** Poses inside the interval, spread through it, for the exact solids to confirm. */
  probes: { value: number; pose: Pose }[];
}

export interface SweepResult {
  joint: string;
  unit: '°' | 'mm';
  low: number;
  high: number;
  samples: number;
  /** The step of the sweep, in the joint's unit. */
  step: number;
  intervals: MotionInterval[];
  /** Set when the joint could not move on, for example at the dead point of a loop. The travel after it was not checked. */
  stoppedAt?: number;
}

export interface SweepOptions {
  /** Called now and then with the share done (0 to 1). The sweep waits for what it returns, so the page can draw. */
  progress?(done: number): Promise<void> | void;
  cancelled?(): boolean;
  /** Sweep only this part of the travel, in the joint's unit. Used by tests and probes. */
  range?: [number, number];
}

const probeCount = 5;

function spread<T>(list: T[], count: number): T[] {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, k) => list[Math.round((k * (list.length - 1)) / (count - 1))]);
}

/**
 * Move one joint through its whole travel, the others where they are in `pose`, and find where each pair of parts collides. A
 * hinge that may turn fully is swept through 360 degrees. In a loop, the other joints move with it.
 */
export async function sweepJoint(checker: CollisionChecker, pose: Pose, name: string, options: SweepOptions = {}): Promise<SweepResult> {
  const { assembly } = checker;
  const count = assembly.parts.length;
  const travel = travelOf(assembly, name);
  const { unit, tolerance } = travel;
  const low = Math.max(travel.low, options.range?.[0] ?? travel.low);
  const high = Math.min(travel.high, options.range?.[1] ?? travel.high);
  const step = sweepStep(checker, pose, name);
  const samples = Math.max(1, Math.ceil((high - low) / step - 1e-9));
  const interval = (high - low) / samples;
  const intervals: MotionInterval[] = [];
  const open = new Map<number, { from: number; openFrom: boolean; inside: { value: number; pose: Pose }[] }>();
  let previous: { value: number; pose: Pose } | undefined;
  let stoppedAt: number | undefined;
  let lastYield = performance.now();

  /** Between a pose where `wanted` is not so and a value where it is: the value where it changes, to the tolerance. */
  const between = (clear: { value: number; pose: Pose }, found: number, key: number, collides: boolean) => {
    let near = clear.value;
    let far = found;
    while (Math.abs(far - near) > tolerance) {
      const mid = (near + far) / 2;
      const moved = moveJoint(assembly, clear.pose, name, mid);
      const now = collidingIn(checker, moved.pose).has(key);
      if (now === collides) far = mid;
      else near = mid;
    }
    return (near + far) / 2;
  };

  for (let k = 0; k <= samples; k++) {
    if (options.cancelled?.()) break;
    const value = low + interval * k;
    const moved = moveJoint(assembly, previous?.pose ?? pose, name, value);
    if (!moved.reached) {
      stoppedAt = previous?.value ?? low;
      break;
    }
    const here = { value, pose: moved.pose };
    const hits = collidingIn(checker, moved.pose);
    for (const key of hits) {
      const run = open.get(key);
      if (run) run.inside.push(here);
      else open.set(key, { from: previous ? between(previous, value, key, true) : value, openFrom: !previous, inside: [here] });
    }
    for (const [key, run] of open) {
      if (hits.has(key)) continue;
      open.delete(key);
      intervals.push({
        a: Math.floor(key / count), b: key % count, joint: name, from: run.from, to: between(previous!, value, key, false), openFrom: run.openFrom, openTo: false,
        probes: spread(run.inside, probeCount),
      });
    }
    previous = here;
    // About every 30 ms, so the page can draw and answer a click between two stretches of work.
    if (options.progress && performance.now() - lastYield > 30) {
      await options.progress(k / samples);
      lastYield = performance.now();
    }
  }
  for (const [key, run] of open) {
    intervals.push({
      a: Math.floor(key / count), b: key % count, joint: name, from: run.from, to: run.inside[run.inside.length - 1].value, openFrom: run.openFrom, openTo: true,
      probes: spread(run.inside, probeCount),
    });
  }
  intervals.sort((x, y) => x.from - y.from || x.a - y.a || x.b - y.b);
  return { joint: name, unit, low, high, samples: samples + 1, step: interval, intervals, stoppedAt };
}

/** The result of asking to move a joint without running into anything new. */
export interface ClearMove {
  pose: Pose;
  /** True when the move was cut short by a collision. */
  blocked: boolean;
  /** The pairs that stopped it. */
  by: [number, number][];
  /** False when the loop could not follow the joint to the value asked for. */
  reached: boolean;
}

/**
 * Move a joint toward a value and stop at the last pose before two parts that did not collide start to. A pair that already
 * collides in `pose` does not stop it, so a machine that starts in contact can still be moved out of it.
 */
export function clearMove(checker: CollisionChecker, pose: Pose, name: string, target: number): ClearMove {
  const { assembly } = checker;
  const count = assembly.parts.length;
  const { tolerance } = travelOf(assembly, name);
  const moved = moveJoint(assembly, pose, name, target);
  const base = collidingIn(checker, pose);
  const fresh = (candidate: Pose) => [...collidingIn(checker, candidate)].filter((key) => !base.has(key));
  const start = clampJoint(assembly.joints.find((item) => item.name === name)!, pose[name]);
  const end = moved.pose[name] ?? target;
  // Walk toward the value in steps small enough that a thin part is not jumped over.
  let measured = checker.steps.get(name);
  if (measured === undefined) checker.steps.set(name, measured = sweepStep(checker, pose, name));
  const stride = Math.max(Math.abs(end - start) / 2000, Math.min(measured, Math.abs(end - start) || 1));
  const steps = Math.max(1, Math.ceil(Math.abs(end - start) / stride - 1e-9));
  let clear = { value: start, pose };
  for (let k = 1; k <= steps; k++) {
    const value = start + ((end - start) * k) / steps;
    const next = moveJoint(assembly, clear.pose, name, value);
    const stopped = fresh(next.pose);
    if (stopped.length) {
      let near = clear.value;
      let far = value;
      while (Math.abs(far - near) > tolerance) {
        const mid = (near + far) / 2;
        const trial = moveJoint(assembly, clear.pose, name, mid);
        if (fresh(trial.pose).length) far = mid;
        else near = mid;
      }
      const last = moveJoint(assembly, clear.pose, name, near);
      return { pose: last.pose, blocked: true, by: stopped.map((key) => [Math.floor(key / count), key % count]), reached: false };
    }
    clear = { value, pose: next.pose };
    if (!next.reached) return { pose: next.pose, blocked: false, by: [], reached: false };
  }
  return { pose: clear.pose, blocked: false, by: [], reached: moved.reached };
}

/** Every joint that has a value to set, as the names a sweep takes. */
export const sweptJoints = (assembly: AssemblySpec) => movingJoints(assembly).filter((joint) => joint.limits[1] > joint.limits[0]).map((joint) => joint.name);

import type { Matrix } from './engine/assembly.ts';
import { transformPoint } from './engine/measure.ts';
import type { MeasurePickType, PartMesh, Vec3 } from './engine/protocol.ts';

/**
 * Picking for the Measure tool. Pure arithmetic on numbers, so the WebGL view, the software view and
 * the tests all use it. The camera is orthographic, which makes the view an affine map from the
 * model's coordinates to pixels.
 */

/** An orthographic camera in model coordinates. Pixels count from the top left of the canvas. */
export interface PickView {
  /** The model point that lands on pixel (cx, cy). */
  origin: Vec3;
  right: Vec3;
  up: Vec3;
  /** The direction the camera looks, unit length. */
  forward: Vec3;
  /** Pixels per model unit. */
  scale: number;
  cx: number;
  cy: number;
}

export interface PickPart {
  mesh: PartMesh;
  /** Placement in the current pose: 3x4, row-major, a rotation and a translation. */
  matrix: Matrix;
  /** A hidden part cannot be picked. */
  visible: boolean;
}

export interface Hit {
  part: number;
  type: MeasurePickType;
  index: number;
  /** Where the pointer touched, in model coordinates: the point on the face, the nearest point of the edge, or the corner. */
  point: Vec3;
}

/** How near the pointer must be, in pixels. */
export const cornerPixels = 8;
export const edgePixels = 6;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Pixel position and distance along the viewing direction of a model point. */
export function toScreen(view: PickView, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - view.origin[0], p[1] - view.origin[1], p[2] - view.origin[2]];
  return [view.cx + view.scale * dot(d, view.right), view.cy - view.scale * dot(d, view.up), dot(d, view.forward)];
}

/** The ray through a pixel: a point on it and the unit direction. */
export function viewRay(view: PickView, x: number, y: number) {
  const u = (x - view.cx) / view.scale;
  const v = (view.cy - y) / view.scale;
  const origin: Vec3 = [
    view.origin[0] + view.right[0] * u + view.up[0] * v,
    view.origin[1] + view.right[1] * u + view.up[1] * v,
    view.origin[2] + view.right[2] * u + view.up[2] * v,
  ];
  return { origin, dir: view.forward };
}

// A bounding volume hierarchy over the triangles of one part, built the first time the part is picked.

interface Bvh {
  /** min x, y, z, max x, y, z of every node. The left child of an inner node is the next node. */
  box: Float32Array;
  /** An inner node: the index of its right child. A leaf: the first entry of `order`. */
  link: Int32Array;
  /** 0 for an inner node, the number of triangles for a leaf. */
  count: Int32Array;
  order: Uint32Array;
}

const leafSize = 6;
const slack = 1e-5;
const trees = new WeakMap<PartMesh, Bvh>();

function buildBvh(mesh: PartMesh): Bvh {
  const { positions, indices } = mesh;
  const n = indices.length / 3;
  const lows = new Float32Array(n * 3);
  const highs = new Float32Array(n * 3);
  const middle = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = positions[indices[t * 3] * 3 + axis];
      const b = positions[indices[t * 3 + 1] * 3 + axis];
      const c = positions[indices[t * 3 + 2] * 3 + axis];
      lows[t * 3 + axis] = Math.min(a, b, c);
      highs[t * 3 + axis] = Math.max(a, b, c);
      middle[t * 3 + axis] = (a + b + c) / 3;
    }
  }
  const order = Uint32Array.from({ length: n }, (_, t) => t);
  const box: number[] = [];
  const link: number[] = [];
  const count: number[] = [];

  function build(start: number, end: number): number {
    const node = count.length;
    count.push(0);
    link.push(0);
    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const centre = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let axis = 0; axis < 3; axis++) {
        bounds[axis] = Math.min(bounds[axis], lows[t * 3 + axis]);
        bounds[axis + 3] = Math.max(bounds[axis + 3], highs[t * 3 + axis]);
        centre[axis] = Math.min(centre[axis], middle[t * 3 + axis]);
        centre[axis + 3] = Math.max(centre[axis + 3], middle[t * 3 + axis]);
      }
    }
    box.push(...bounds);
    if (end - start <= leafSize) {
      link[node] = start;
      count[node] = end - start;
      return node;
    }
    const spread = [centre[3] - centre[0], centre[4] - centre[1], centre[5] - centre[2]];
    const axis = spread[0] >= spread[1] && spread[0] >= spread[2] ? 0 : spread[1] >= spread[2] ? 1 : 2;
    const cut = (centre[axis] + centre[axis + 3]) / 2;
    // Partition in place around the middle of the triangle centres.
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (middle[order[i] * 3 + axis] < cut) i++;
      else {
        const swap = order[i];
        order[i] = order[j];
        order[j] = swap;
        j--;
      }
    }
    // All centres equal, or all on one side: split in the middle of the list instead.
    const split = i === start || i === end ? (start + end) >> 1 : i;
    build(start, split);
    link[node] = build(split, end);
    return node;
  }

  if (n > 0) build(0, n);
  return { box: Float32Array.from(box), link: Int32Array.from(link), count: Int32Array.from(count), order };
}

/** Build the hierarchy of a part now, so the first hover does not wait for it. */
export function preparePicking(mesh: PartMesh) {
  if (!trees.has(mesh)) trees.set(mesh, buildBvh(mesh));
}

const stack = new Int32Array(128);

/** Nearest triangle that a ray crosses, in the mesh's own coordinates. Both sides of a triangle count. */
function nearest(mesh: PartMesh, o: Vec3, d: Vec3): { t: number; triangle: number } | undefined {
  let tree = trees.get(mesh);
  if (!tree) trees.set(mesh, tree = buildBvh(mesh));
  if (!tree.count.length) return undefined;
  const { box, link, count, order } = tree;
  const { positions, indices } = mesh;
  const inv = d.map((c) => 1 / (Math.abs(c) < 1e-300 ? 1e-300 : c));
  let best = Infinity;
  let found = -1;
  let top = 0;
  stack[top++] = 0;
  while (top) {
    const node = stack[--top];
    // Slab test against the node's box, closer than the best hit so far.
    let near = 0;
    let far = best;
    for (let axis = 0; axis < 3; axis++) {
      const a = (box[node * 6 + axis] - o[axis]) * inv[axis];
      const b = (box[node * 6 + axis + 3] - o[axis]) * inv[axis];
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (near > far * (1 + 1e-9) + 1e-9) continue;
    if (!count[node]) {
      stack[top++] = link[node];
      stack[top++] = node + 1;
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
      // Moller-Trumbore.
      const px = d[1] * e2z - d[2] * e2y;
      const py = d[2] * e2x - d[0] * e2z;
      const pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-18) continue;
      const sx = o[0] - positions[ia];
      const sy = o[1] - positions[ia + 1];
      const sz = o[2] - positions[ia + 2];
      const u = (sx * px + sy * py + sz * pz) / det;
      // A little slack, so a ray through the shared edge of two triangles (a pointer exactly on a corner) hits one of them.
      if (u < -slack || u > 1 + slack) continue;
      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
      if (v < -slack || u + v > 1 + slack) continue;
      const hit = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (hit > 0 && hit < best) {
        best = hit;
        found = t;
      }
    }
  }
  return found < 0 ? undefined : { t: best, triangle: found };
}

/** Model coordinates to a part's own: the placement is a rotation and a translation, so the inverse is its transpose. */
function toLocal(m: Matrix, p: Vec3): Vec3 {
  const d = [p[0] - m[3], p[1] - m[7], p[2] - m[11]];
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

function directionToLocal(m: Matrix, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}

/** The nearest surface along a ray, over every visible part. `t` is the distance along the ray from its origin. */
export function castRay(parts: PickPart[], origin: Vec3, dir: Vec3) {
  let best: { part: number; triangle: number; t: number } | undefined;
  parts.forEach((part, i) => {
    if (!part.visible) return;
    const hit = nearest(part.mesh, toLocal(part.matrix, origin), directionToLocal(part.matrix, dir));
    if (hit && (!best || hit.t < best.t)) best = { part: i, ...hit };
  });
  return best;
}

interface Candidate {
  distance: number;
  /** Distance from the camera plane: of two corners on the same pixel, the nearer one is tried first. */
  depth: number;
  part: number;
  type: 'edge' | 'vertex';
  index: number;
  point: Vec3;
}

/** Whether nothing stands between the camera and a model point that lies on a surface. */
function seen(parts: PickPart[], view: PickView, p: Vec3, tolerance: number) {
  const [x, y, depth] = toScreen(view, p);
  const { origin, dir } = viewRay(view, x, y);
  const hit = castRay(parts, origin, dir);
  // The ray starts on the plane through view.origin, square to the viewing direction, so a point's distance along it is its depth.
  return !hit || hit.t >= depth - tolerance;
}

/**
 * What the pointer is over: a corner within 8 px, else an edge within 6 px, else the face under it.
 * Corners and edges that lie behind a surface do not count. Undefined when the pointer is over nothing.
 */
export function pickAt(parts: PickPart[], view: PickView, x: number, y: number): Hit | undefined {
  const tolerance = 3 / view.scale;
  const candidates: Candidate[] = [];

  parts.forEach((part, i) => {
    if (!part.visible) return;
    const { mesh, matrix: m } = part;
    // One matrix from the part's coordinates to pixels, so a point costs one pass.
    const rows = [view.right, view.up, view.forward].map((axis, row) => {
      const sign = row === 1 ? -1 : 1;
      const w = [0, 1, 2, 3].map((col) => {
        const column = col < 3 ? [m[col], m[4 + col], m[8 + col]] : [m[3] - view.origin[0], m[7] - view.origin[1], m[11] - view.origin[2]];
        return sign * (axis[0] * column[0] + axis[1] * column[1] + axis[2] * column[2]);
      });
      return w;
    });
    const sx = view.scale;
    const [rx, ry] = [rows[0], rows[1]];
    const screenX = (px: number, py: number, pz: number) => view.cx + sx * (rx[0] * px + rx[1] * py + rx[2] * pz + rx[3]);
    const screenY = (px: number, py: number, pz: number) => view.cy + sx * (ry[0] * px + ry[1] * py + ry[2] * pz + ry[3]);

    // Skip the part when the pointer is far from its bounding box on screen.
    const { min, max } = mesh.bounds;
    let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const px = c & 1 ? max[0] : min[0];
      const py = c & 2 ? max[1] : min[1];
      const pz = c & 4 ? max[2] : min[2];
      const [sxp, syp] = [screenX(px, py, pz), screenY(px, py, pz)];
      left = Math.min(left, sxp);
      right = Math.max(right, sxp);
      top = Math.min(top, syp);
      bottom = Math.max(bottom, syp);
    }
    if (x < left - cornerPixels || x > right + cornerPixels || y < top - cornerPixels || y > bottom + cornerPixels) return;

    const { corners } = mesh;
    for (let c = 0; c < corners.length; c += 3) {
      const distance = Math.hypot(screenX(corners[c], corners[c + 1], corners[c + 2]) - x, screenY(corners[c], corners[c + 1], corners[c + 2]) - y);
      if (distance <= cornerPixels) {
        const point = transformPoint(m, corners, c);
        candidates.push({ distance, depth: toScreen(view, point)[2], part: i, type: 'vertex', index: c / 3, point });
      }
    }

    const { edgeSegments: lines, edgeOf } = mesh;
    for (let s = 0; s < edgeOf.length; s++) {
      const k = s * 6;
      const ax = screenX(lines[k], lines[k + 1], lines[k + 2]);
      const ay = screenY(lines[k], lines[k + 1], lines[k + 2]);
      const bx = screenX(lines[k + 3], lines[k + 4], lines[k + 5]);
      const by = screenY(lines[k + 3], lines[k + 4], lines[k + 5]);
      if (Math.min(ax, bx) > x + edgePixels || Math.max(ax, bx) < x - edgePixels || Math.min(ay, by) > y + edgePixels || Math.max(ay, by) < y - edgePixels) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const length = dx * dx + dy * dy;
      const along = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      const distance = Math.hypot(ax + along * dx - x, ay + along * dy - y);
      if (distance > edgePixels) continue;
      const point = transformPoint(m, [lines[k] + along * (lines[k + 3] - lines[k]), lines[k + 1] + along * (lines[k + 4] - lines[k + 1]), lines[k + 2] + along * (lines[k + 5] - lines[k + 2])]);
      const known = candidates.find((candidate) => candidate.type === 'edge' && candidate.part === i && candidate.index === edgeOf[s]);
      if (known) {
        if (distance < known.distance) Object.assign(known, { distance, point, depth: toScreen(view, point)[2] });
      } else {
        candidates.push({ distance, depth: toScreen(view, point)[2], part: i, type: 'edge', index: edgeOf[s], point });
      }
    }
  });

  for (const type of ['vertex', 'edge'] as const) {
    const ordered = candidates.filter((candidate) => candidate.type === type).sort((a, b) => (Math.abs(a.distance - b.distance) < 1e-6 ? a.depth - b.depth : a.distance - b.distance));
    for (const candidate of ordered.slice(0, 4)) {
      if (seen(parts, view, candidate.point, tolerance)) return { part: candidate.part, type: candidate.type === 'vertex' ? 'vertex' : 'edge', index: candidate.index, point: candidate.point };
    }
  }

  const { origin, dir } = viewRay(view, x, y);
  const hit = castRay(parts, origin, dir);
  if (!hit) return undefined;
  const { mesh } = parts[hit.part];
  return {
    part: hit.part,
    type: 'face',
    index: mesh.faceOf[hit.triangle],
    point: [origin[0] + dir[0] * hit.t, origin[1] + dir[1] * hit.t, origin[2] + dir[2] * hit.t],
  };
}

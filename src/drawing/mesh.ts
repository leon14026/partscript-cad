import type { PartMesh } from '../engine/protocol.ts';
import { viewFrames } from './frames.ts';
import type { Curve, Vec2, Vec3, ViewData, ViewName } from './types.ts';

/**
 * Views of a faceted part, which has no solid to project (sewing one takes seconds). The lines are the preview's crease edges, which
 * `toPartMesh` finds where faces turn by 28 degrees or more, and the silhouettes: the mesh edges where a face that looks at the viewer
 * meets one that looks away. Each line is split into its visible and hidden pieces by testing points along it against the triangles.
 */

const hiddenReturnLimit = 1000;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};

interface Projected {
  /** Per vertex: position across, up and toward the viewer. */
  u: Float64Array;
  w: Float64Array;
  z: Float64Array;
}

/** A uniform grid over the view that lists, for each cell, the triangles whose bounding box reaches it. */
class TriangleGrid {
  #x0: number;
  #y0: number;
  #cell: number;
  #nx: number;
  #ny: number;
  #start: Int32Array;
  #items: Int32Array;

  constructor(p: Projected, indices: Uint32Array, box: [number, number, number, number]) {
    const triangles = indices.length / 3;
    const cells = Math.max(8, Math.min(160, Math.round(Math.sqrt(triangles) / 1.5)));
    const width = Math.max(box[2] - box[0], 1e-9);
    const height = Math.max(box[3] - box[1], 1e-9);
    this.#cell = Math.max(width, height) / cells;
    this.#x0 = box[0];
    this.#y0 = box[1];
    this.#nx = Math.max(1, Math.ceil(width / this.#cell));
    this.#ny = Math.max(1, Math.ceil(height / this.#cell));
    const counts = new Int32Array(this.#nx * this.#ny + 1);
    const each = (visit: (t: number, cx: number, cy: number) => void) => {
      for (let t = 0; t < triangles; t++) {
        const a = indices[t * 3];
        const b = indices[t * 3 + 1];
        const c = indices[t * 3 + 2];
        const x0 = Math.min(p.u[a], p.u[b], p.u[c]);
        const x1 = Math.max(p.u[a], p.u[b], p.u[c]);
        const y0 = Math.min(p.w[a], p.w[b], p.w[c]);
        const y1 = Math.max(p.w[a], p.w[b], p.w[c]);
        const [i0, i1] = [this.#col(x0), this.#col(x1)];
        const [j0, j1] = [this.#row(y0), this.#row(y1)];
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) visit(t, i, j);
      }
    };
    each((_, i, j) => counts[j * this.#nx + i + 1]++);
    for (let k = 0; k < this.#nx * this.#ny; k++) counts[k + 1] += counts[k];
    this.#start = counts;
    this.#items = new Int32Array(counts[this.#nx * this.#ny]);
    const filled = new Int32Array(this.#nx * this.#ny);
    each((t, i, j) => {
      const k = j * this.#nx + i;
      this.#items[this.#start[k] + filled[k]++] = t;
    });
  }

  #col(x: number) {
    return Math.max(0, Math.min(this.#nx - 1, Math.floor((x - this.#x0) / this.#cell)));
  }

  #row(y: number) {
    return Math.max(0, Math.min(this.#ny - 1, Math.floor((y - this.#y0) / this.#cell)));
  }

  /** The triangles that may cover the point. */
  near(x: number, y: number) {
    const k = this.#row(y) * this.#nx + this.#col(x);
    return this.#items.subarray(this.#start[k], this.#start[k + 1]);
  }
}

/** One view of a faceted part. */
export function meshView(mesh: PartMesh, name: Exclude<ViewName, 'section'>): ViewData {
  const { dir, x: across } = viewFrames[name];
  const d = unit(dir);
  const x = unit(across);
  const y = cross(d, x);
  const n = mesh.positions.length / 3;
  const p: Projected = { u: new Float64Array(n), w: new Float64Array(n), z: new Float64Array(n) };
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const v: Vec3 = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    p.u[i] = dot(v, x);
    p.w[i] = dot(v, y);
    p.z[i] = dot(v, d);
    box = [Math.min(box[0], p.u[i]), Math.min(box[1], p.w[i]), Math.max(box[2], p.u[i]), Math.max(box[3], p.w[i])];
  }
  const size = Math.max(box[2] - box[0], box[3] - box[1], 1e-6);
  const depthTolerance = Math.max(1e-6, size * 1e-5);
  const { indices } = mesh;
  const triangles = indices.length / 3;
  const grid = new TriangleGrid(p, indices, box);

  /** True when a triangle that is nearer the viewer covers the point, which lies at `depth`. */
  const covered = (px: number, py: number, depth: number) => {
    for (const t of grid.near(px, py)) {
      const a = indices[t * 3];
      const b = indices[t * 3 + 1];
      const c = indices[t * 3 + 2];
      const area = (p.u[b] - p.u[a]) * (p.w[c] - p.w[a]) - (p.u[c] - p.u[a]) * (p.w[b] - p.w[a]);
      if (Math.abs(area) < 1e-12 * size * size) continue;
      const l0 = ((p.u[b] - px) * (p.w[c] - py) - (p.u[c] - px) * (p.w[b] - py)) / area;
      const l1 = ((p.u[c] - px) * (p.w[a] - py) - (p.u[a] - px) * (p.w[c] - py)) / area;
      const l2 = 1 - l0 - l1;
      const slack = -1e-9;
      if (l0 < slack || l1 < slack || l2 < slack) continue;
      if (l0 * p.z[a] + l1 * p.z[b] + l2 * p.z[c] > depth + depthTolerance) return true;
    }
    return false;
  };

  /** The visible and hidden pieces of a segment, as parameter ranges along it. */
  const split = (a: Vec3, b: Vec3): { from: number; to: number; hidden: boolean }[] => {
    const au = dot(a, x), aw = dot(a, y), az = dot(a, d);
    const bu = dot(b, x), bw = dot(b, y), bz = dot(b, d);
    const length = Math.hypot(bu - au, bw - aw);
    if (length < size * 1e-7) return [];
    const at = (t: number) => covered(au + (bu - au) * t, aw + (bw - aw) * t, az + (bz - az) * t);
    const samples = Math.max(2, Math.min(200, Math.ceil(length / (size / 120))));
    const runs: { from: number; to: number; hidden: boolean }[] = [];
    let previous = at(0);
    let from = 0;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const state = at(t);
      if (state !== previous) {
        let low = (i - 1) / samples;
        let high = t;
        for (let step = 0; step < 14; step++) {
          const middle = (low + high) / 2;
          if (at(middle) === previous) low = middle;
          else high = middle;
        }
        const edge = (low + high) / 2;
        runs.push({ from, to: edge, hidden: previous });
        from = edge;
        previous = state;
      }
    }
    runs.push({ from, to: 1, hidden: previous });
    return runs.filter((run) => run.to - run.from > 1e-6);
  };

  // The silhouette edges: mesh edges between a triangle that looks toward the viewer and one that looks away.
  const quantum = size * 1e-6;
  const keyOf = (i: number) => `${Math.round(mesh.positions[i * 3] / quantum)},${Math.round(mesh.positions[i * 3 + 1] / quantum)},${Math.round(mesh.positions[i * 3 + 2] / quantum)}`;
  const facing = new Float64Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    const pa: Vec3 = [mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2]];
    const pb: Vec3 = [mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2]];
    const pc: Vec3 = [mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2]];
    const normal = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
    const stored: Vec3 = [0, 0, 0];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) stored[k] += mesh.normals[i * 3 + k];
    const sign = dot(normal, stored) < 0 ? -1 : 1;
    const length = Math.hypot(...normal);
    facing[t] = length < 1e-30 ? 0 : (sign * dot(normal, d)) / length;
  }
  const edges = new Map<string, { a: number; b: number; first: number; count: number; silhouette: boolean }>();
  const flat = 1e-9;
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k];
      const b = indices[t * 3 + ((k + 1) % 3)];
      const [ka, kb] = [keyOf(a), keyOf(b)];
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const known = edges.get(key);
      if (!known) edges.set(key, { a, b, first: facing[t], count: 1, silhouette: false });
      else {
        known.count++;
        const other = facing[t];
        if (known.first * other <= 0 && (Math.abs(known.first) > flat || Math.abs(other) > flat)) known.silhouette = true;
      }
    }
  }

  const segments: [Vec3, Vec3][] = [];
  for (const edge of edges.values()) {
    if (!edge.silhouette) continue;
    segments.push([[mesh.positions[edge.a * 3], mesh.positions[edge.a * 3 + 1], mesh.positions[edge.a * 3 + 2]], [mesh.positions[edge.b * 3], mesh.positions[edge.b * 3 + 1], mesh.positions[edge.b * 3 + 2]]]);
  }

  for (let i = 0; i + 5 < mesh.edgeSegments.length; i += 6) {
    segments.push([[mesh.edgeSegments[i], mesh.edgeSegments[i + 1], mesh.edgeSegments[i + 2]], [mesh.edgeSegments[i + 3], mesh.edgeSegments[i + 4], mesh.edgeSegments[i + 5]]]);
  }

  const visible: [Vec2, Vec2][] = [];
  const hidden: [Vec2, Vec2][] = [];
  for (const [a, b] of segments) {
    for (const run of split(a, b)) {
      const lerp = (t: number): Vec2 => {
        const point: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        return [dot(point, x), dot(point, y)];
      };
      (run.hidden ? hidden : visible).push([lerp(run.from), lerp(run.to)]);
    }
  }

  const seen = visibleCurves(visible, size);
  let hiddenCurves = visibleCurves(hidden, size);
  const omitted = hiddenCurves.length > hiddenReturnLimit ? hiddenCurves.length : 0;
  if (omitted) hiddenCurves = [];
  let curvesBox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const curve of seen) {
    const points = curve.kind === 'line' ? [curve.a, curve.b] : curve.kind === 'poly' ? curve.points : [];
    for (const point of points) curvesBox = [Math.min(curvesBox[0], point[0]), Math.min(curvesBox[1], point[1]), Math.max(curvesBox[2], point[0]), Math.max(curvesBox[3], point[1])];
  }
  return { name, visible: seen, hidden: hiddenCurves, hiddenOmitted: omitted, box: Number.isFinite(curvesBox[0]) ? curvesBox : [0, 0, 0, 0] };
}

/**
 * Join pieces that meet end to end and bend by less than 50 degrees into one polyline, so a faceted circle is one curve and not a
 * ring of short lines, while the corners of a box stay separate lines. Duplicates (the same silhouette found twice) are dropped.
 */
function visibleCurves(pieces: [Vec2, Vec2][], size: number): Curve[] {
  const quantum = Math.max(size * 1e-6, 1e-9);
  const keyOf = (point: Vec2) => `${Math.round(point[0] / quantum)},${Math.round(point[1] / quantum)}`;
  const unique = new Map<string, [Vec2, Vec2]>();
  for (const piece of pieces) {
    const [ka, kb] = [keyOf(piece[0]), keyOf(piece[1])];
    if (ka === kb) continue;
    unique.set(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`, piece);
  }
  const list = [...unique.values()];
  const at = new Map<string, number[]>();
  list.forEach((piece, i) => {
    for (const end of piece) at.set(keyOf(end), [...(at.get(keyOf(end)) ?? []), i]);
  });
  const used = new Array<boolean>(list.length).fill(false);
  const curves: Curve[] = [];
  const turn = (from: Vec2, through: Vec2, to: Vec2) => {
    const a = [through[0] - from[0], through[1] - from[1]];
    const b = [to[0] - through[0], to[1] - through[1]];
    return Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
  };
  const limit = (50 * Math.PI) / 180;
  for (let start = 0; start < list.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const chain: Vec2[] = [list[start][0], list[start][1]];
    // Grow at the far end, then at the near end.
    for (const atEnd of [true, false]) {
      for (let grew = true; grew;) {
        grew = false;
        const tip = atEnd ? chain[chain.length - 1] : chain[0];
        const before = atEnd ? chain[chain.length - 2] : chain[1];
        const joins = (at.get(keyOf(tip)) ?? []).filter((i) => !used[i]);
        if ((at.get(keyOf(tip)) ?? []).length !== 2 || joins.length !== 1) break;
        const piece = list[joins[0]];
        const far = keyOf(piece[0]) === keyOf(tip) ? piece[1] : piece[0];
        if (turn(before, tip, far) > limit) break;
        used[joins[0]] = true;
        if (atEnd) chain.push(far);
        else chain.unshift(far);
        grew = true;
      }
    }
    if (chain.length === 2) curves.push({ kind: 'line', a: chain[0], b: chain[1] });
    else {
      // Pieces in one straight run are one line.
      const [a, b] = [chain[0], chain[chain.length - 1]];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const straight = length > 0 && chain.every((point) => Math.abs((point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0])) / length < size * 1e-6);
      curves.push(straight ? { kind: 'line', a, b } : { kind: 'poly', points: chain });
    }
  }
  return curves;
}

/** The four views of a faceted part. */
export function meshViews(mesh: PartMesh): ViewData[] {
  return (['front', 'top', 'right', 'iso'] as const).map((name) => meshView(mesh, name));
}

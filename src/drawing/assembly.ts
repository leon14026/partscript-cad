import type { Matrix } from '../engine/assembly.ts';
import type { PartMesh } from '../engine/protocol.ts';
import { viewFrames } from './frames.ts';
import { meshView } from './mesh.ts';
import type { AssemblyBalloon, ViewData, Vec2, Vec3 } from './types.ts';

/** One part of an assembly as it stands in the pose: its solid's mesh and where it sits. */
export interface PlacedMesh {
  mesh: PartMesh;
  matrix: Matrix;
}

const resolution = 260;

/** The meshes of an assembly in one mesh, each part moved to its place, so lines of a part that another part hides are hidden. */
function mergeMeshes(placed: PlacedMesh[]): { mesh: PartMesh; owner: Uint16Array } {
  let vertices = 0;
  let indices = 0;
  let segments = 0;
  for (const { mesh } of placed) {
    vertices += mesh.positions.length;
    indices += mesh.indices.length;
    segments += mesh.edgeSegments.length;
  }
  const positions = new Float32Array(vertices);
  const normals = new Float32Array(vertices);
  const index = new Uint32Array(indices);
  const edgeSegments = new Float32Array(segments);
  const owner = new Uint16Array(indices / 3);
  let [v, t, s] = [0, 0, 0];
  const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  placed.forEach(({ mesh, matrix: m }, part) => {
    const move = (from: Float32Array, to: Float32Array, at: number, rotateOnly: boolean) => {
      for (let i = 0; i < from.length; i += 3) {
        const [x, y, z] = [from[i], from[i + 1], from[i + 2]];
        to[at + i] = m[0] * x + m[1] * y + m[2] * z + (rotateOnly ? 0 : m[3]);
        to[at + i + 1] = m[4] * x + m[5] * y + m[6] * z + (rotateOnly ? 0 : m[7]);
        to[at + i + 2] = m[8] * x + m[9] * y + m[10] * z + (rotateOnly ? 0 : m[11]);
      }
    };
    move(mesh.positions, positions, v, false);
    move(mesh.normals, normals, v, true);
    move(mesh.edgeSegments, edgeSegments, s, false);
    for (let i = 0; i < mesh.indices.length; i++) index[t * 3 + i] = mesh.indices[i] + v / 3;
    for (let i = 0; i < mesh.indices.length / 3; i++) owner[t + i] = part;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], positions[v + i + axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], positions[v + i + axis]);
      }
    }
    v += mesh.positions.length;
    t += mesh.indices.length / 3;
    s += mesh.edgeSegments.length;
  });
  return {
    mesh: {
      positions, normals, indices: index, edgeSegments,
      faceOf: new Uint32Array(0), edgeOf: new Uint32Array(0), corners: new Float64Array(0),
      bounds, volume: 0, quality: 'faceted',
    },
    owner,
  };
}

/**
 * For each part, a point on it that shows in the view: of the pixels that a part owns in a depth buffer of the view, an interior one
 * (all four neighbours the same part) nearest to the middle of them. A part that owns no pixel gets none.
 */
function visiblePoints(merged: PartMesh, owner: Uint16Array, parts: number): (Vec2 | undefined)[] {
  const { dir, x: across } = viewFrames.iso;
  const d = unit(dir);
  const x = unit(across);
  const y = cross(d, x);
  const n = merged.positions.length / 3;
  const [u, w, z] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [merged.positions[i * 3], merged.positions[i * 3 + 1], merged.positions[i * 3 + 2]];
    u[i] = dot(p, x);
    w[i] = dot(p, y);
    z[i] = dot(p, d);
    box = [Math.min(box[0], u[i]), Math.min(box[1], w[i]), Math.max(box[2], u[i]), Math.max(box[3], w[i])];
  }
  const cell = Math.max(box[2] - box[0], box[3] - box[1], 1e-9) / resolution;
  const [nx, ny] = [Math.ceil((box[2] - box[0]) / cell) + 1, Math.ceil((box[3] - box[1]) / cell) + 1];
  const depth = new Float64Array(nx * ny).fill(-Infinity);
  const id = new Int32Array(nx * ny).fill(-1);
  const { indices } = merged;
  for (let t = 0; t < indices.length / 3; t++) {
    const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    const area = (u[b] - u[a]) * (w[c] - w[a]) - (u[c] - u[a]) * (w[b] - w[a]);
    if (Math.abs(area) < 1e-12) continue;
    const [i0, i1] = [Math.max(0, Math.floor((Math.min(u[a], u[b], u[c]) - box[0]) / cell)), Math.min(nx - 1, Math.ceil((Math.max(u[a], u[b], u[c]) - box[0]) / cell))];
    const [j0, j1] = [Math.max(0, Math.floor((Math.min(w[a], w[b], w[c]) - box[1]) / cell)), Math.min(ny - 1, Math.ceil((Math.max(w[a], w[b], w[c]) - box[1]) / cell))];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const [px, py] = [box[0] + i * cell, box[1] + j * cell];
        const l0 = ((u[b] - px) * (w[c] - py) - (u[c] - px) * (w[b] - py)) / area;
        const l1 = ((u[c] - px) * (w[a] - py) - (u[a] - px) * (w[c] - py)) / area;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const depthHere = l0 * z[a] + l1 * z[b] + l2 * z[c];
        if (depthHere > depth[j * nx + i]) {
          depth[j * nx + i] = depthHere;
          id[j * nx + i] = owner[t];
        }
      }
    }
  }

  const sum = Array.from({ length: parts }, () => [0, 0, 0]);
  for (let k = 0; k < id.length; k++) {
    if (id[k] < 0) continue;
    const s = sum[id[k]];
    s[0] += k % nx;
    s[1] += Math.floor(k / nx);
    s[2]++;
  }
  const best = new Array<{ k: number; distance: number } | undefined>(parts).fill(undefined);
  for (let k = 0; k < id.length; k++) {
    const part = id[k];
    if (part < 0) continue;
    const [i, j] = [k % nx, Math.floor(k / nx)];
    const inside = i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && id[k - 1] === part && id[k + 1] === part && id[k - nx] === part && id[k + nx] === part;
    if (!inside) continue;
    const s = sum[part];
    const distance = Math.hypot(i - s[0] / s[2], j - s[1] / s[2]);
    if (!best[part] || distance < best[part]!.distance) best[part] = { k, distance };
  }
  // A sliver that has no interior pixel still shows, so it takes the pixel of its own that is nearest its middle.
  for (let part = 0; part < parts; part++) {
    if (best[part] || !sum[part][2]) continue;
    for (let k = 0; k < id.length; k++) {
      if (id[k] !== part) continue;
      const distance = Math.hypot((k % nx) - sum[part][0] / sum[part][2], Math.floor(k / nx) - sum[part][1] / sum[part][2]);
      if (!best[part] || distance < best[part]!.distance) best[part] = { k, distance };
    }
  }
  return best.map((found) => (found ? [box[0] + (found.k % nx) * cell, box[1] + Math.floor(found.k / nx) * cell] : undefined));
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};

/**
 * The isometric view of a whole assembly in a pose, and a point on each part that the view shows, for its balloon. `item` gives the
 * parts-list number of each part. A part that no pixel shows gets a leader to the middle of its bounding box, and `hidden` set.
 */
export function assemblyView(placed: PlacedMesh[], item: number[]): { view: ViewData; balloons: AssemblyBalloon[] } {
  const { mesh, owner } = mergeMeshes(placed);
  const view = meshView(mesh, 'iso');
  const points = visiblePoints(mesh, owner, placed.length);
  const { dir, x: across } = viewFrames.iso;
  const d = unit(dir);
  const x = unit(across);
  const y = cross(d, x);
  const balloons = placed.map(({ mesh: part, matrix: m }, i): AssemblyBalloon => {
    if (points[i]) return { item: item[i], point: points[i]!, hidden: false };
    const centre: Vec3 = [0, 1, 2].map((axis) => (part.bounds.min[axis] + part.bounds.max[axis]) / 2) as Vec3;
    const moved: Vec3 = [0, 1, 2].map((row) => m[row * 4] * centre[0] + m[row * 4 + 1] * centre[1] + m[row * 4 + 2] * centre[2] + m[row * 4 + 3]) as Vec3;
    return { item: item[i], point: [dot(moved, x), dot(moved, y)], hidden: true };
  });
  return { view, balloons };
}

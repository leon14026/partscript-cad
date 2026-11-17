import type { PartMesh, Vec3 } from './protocol.ts';

/** Triangles as a flat list: 9 numbers (three corners) per triangle. */
export interface TriangleSoup {
  positions: Float32Array<ArrayBuffer>;
}

/** The most triangles a part may have and still be previewed. */
export const maxTriangles = 500_000;

const weldScale = 1e5; // vertices closer than 1e-5 mm are the same vertex

/** Read a binary STL: an 80-byte header, a uint32 triangle count, then 50 bytes per triangle. */
export function parseBinaryStl(bytes: Uint8Array): TriangleSoup {
  if (bytes.byteLength < 84) throw new Error('The mesh file is too short.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (bytes.byteLength < 84 + count * 50) throw new Error('The mesh file ends early.');
  const positions = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    // Skip the stored normal (12 bytes) and the 2-byte attribute count.
    const at = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = view.getFloat32(at + k * 4, true);
  }
  return { positions };
}

/** Enclosed volume: the sum of signed tetrahedra against the origin. Positive for outward-facing triangles. */
export function meshVolume({ positions: p }: TriangleSoup): number {
  let sum = 0;
  for (let i = 0; i < p.length; i += 9) {
    sum += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
      - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
      + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  return sum / 6;
}

export function meshBounds({ positions: p }: TriangleSoup): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

/**
 * Make what the viewers draw from a triangle soup. Every triangle keeps its own
 * three vertices and its own normal, so a faceted part looks faceted. Edges are
 * drawn where two triangles meet at more than creaseDegrees, and along any edge
 * that is not shared by exactly two triangles.
 */
export function toPartMesh(soup: TriangleSoup, creaseDegrees = 28): Omit<PartMesh, 'volume' | 'quality' | 'reason'> {
  const { positions: p } = soup;
  const triangleCount = p.length / 9;

  // Weld vertices that are equal after rounding, to find which triangles share an edge.
  const welded = new Map<string, number>();
  const corner = new Int32Array(triangleCount * 3);
  for (let i = 0; i < triangleCount * 3; i++) {
    const key = `${Math.round(p[i * 3] * weldScale)},${Math.round(p[i * 3 + 1] * weldScale)},${Math.round(p[i * 3 + 2] * weldScale)}`;
    let index = welded.get(key);
    if (index === undefined) {
      index = welded.size;
      welded.set(key, index);
    }
    corner[i] = index;
  }
  const vertexCount = welded.size;

  // One normal per triangle. Triangles with no area are left out of the picture.
  const keep = new Uint8Array(triangleCount);
  const faceNormal = new Float64Array(triangleCount * 3);
  let kept = 0;
  for (let t = 0; t < triangleCount; t++) {
    const i = t * 9;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const norm = Math.hypot(nx, ny, nz);
    const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
    if (norm < 1e-12 || a === b || b === c || a === c) continue;
    keep[t] = 1;
    kept++;
    faceNormal[t * 3] = nx / norm;
    faceNormal[t * 3 + 1] = ny / norm;
    faceNormal[t * 3 + 2] = nz / norm;
  }

  const outPositions = new Float32Array(kept * 9);
  const normals = new Float32Array(kept * 9);
  const indices = new Uint32Array(kept * 3);
  let out = 0;
  for (let t = 0; t < triangleCount; t++) {
    if (!keep[t]) continue;
    outPositions.set(p.subarray(t * 9, t * 9 + 9), out * 9);
    for (let k = 0; k < 3; k++) {
      normals.set(faceNormal.subarray(t * 3, t * 3 + 3), out * 9 + k * 3);
      indices[out * 3 + k] = out * 3 + k;
    }
    out++;
  }

  // Feature edges. An edge is keyed by its two welded vertices, smaller index first.
  const cosCrease = Math.cos((creaseDegrees * Math.PI) / 180);
  const edges = new Map<number, { first: number; count: number; sharp: boolean }>();
  for (let t = 0; t < triangleCount; t++) {
    if (!keep[t]) continue;
    for (let k = 0; k < 3; k++) {
      const a = corner[t * 3 + k];
      const b = corner[t * 3 + (k + 1) % 3];
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      const edge = edges.get(key);
      if (!edge) {
        edges.set(key, { first: t * 3 + k, count: 1, sharp: false });
        continue;
      }
      edge.count++;
      const other = Math.floor(edge.first / 3);
      const dotted = faceNormal[t * 3] * faceNormal[other * 3] + faceNormal[t * 3 + 1] * faceNormal[other * 3 + 1] + faceNormal[t * 3 + 2] * faceNormal[other * 3 + 2];
      if (dotted < cosCrease) edge.sharp = true;
    }
  }
  const segments: number[] = [];
  for (const edge of edges.values()) {
    if (edge.count === 2 && !edge.sharp) continue;
    const t = Math.floor(edge.first / 3);
    const k = edge.first % 3;
    const from = t * 9 + k * 3;
    const to = t * 9 + ((k + 1) % 3) * 3;
    segments.push(p[from], p[from + 1], p[from + 2], p[to], p[to + 1], p[to + 2]);
  }

  return {
    positions: outPositions,
    normals,
    indices,
    edgeSegments: new Float32Array(segments),
    bounds: meshBounds({ positions: outPositions }),
  };
}

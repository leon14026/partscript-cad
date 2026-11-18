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

/**
 * Read an STL, binary or ASCII. A binary file is the one whose length is exactly 84 bytes plus 50 per
 * triangle (some writers add bytes at the end, which is accepted when the file does not start with "solid");
 * anything else that starts with "solid" is read as text.
 */
export function parseStl(bytes: Uint8Array): TriangleSoup {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (bytes.byteLength >= 84) {
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    const needed = 84 + count * 50;
    if (needed === bytes.byteLength || (needed < bytes.byteLength && count > 0 && !head.startsWith('solid'))) {
      return checkedSoup(parseBinaryStl(bytes));
    }
    if (needed > bytes.byteLength && count > 0 && !head.startsWith('solid')) {
      throw new Error(`This is not an STL file, or it was cut short: its header promises ${count.toLocaleString('en-US')} triangles and the file has room for ${Math.floor((bytes.byteLength - 84) / 50).toLocaleString('en-US')}. If it is an STL, download it again.`);
    }
  }
  if (!head.startsWith('solid')) {
    throw new Error('This is not an STL file: it is neither a binary STL nor a text STL that starts with "solid". Check that it is not another format with a renamed extension.');
  }
  const text = new TextDecoder().decode(bytes);
  const numbers: number[] = [];
  for (const match of text.matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) numbers.push(Number(match[1]), Number(match[2]), Number(match[3]));
  if (!numbers.length || numbers.length % 9 !== 0) {
    throw new Error('The text STL has no triangles, or a triangle without three vertices. If it is a binary STL, it may be cut short.');
  }
  return checkedSoup({ positions: Float32Array.from(numbers) });
}

function checkedSoup(soup: TriangleSoup): TriangleSoup {
  if (!soup.positions.length) throw new Error('The STL has no triangles.');
  for (let i = 0; i < soup.positions.length; i++) {
    if (!Number.isFinite(soup.positions[i])) throw new Error('The STL has a coordinate that is not a number.');
  }
  return soup;
}

/** The same triangles with the opposite winding, for a mesh whose triangles face inward. */
export function flipTriangles({ positions: p }: TriangleSoup): TriangleSoup {
  const flipped = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 9) {
    flipped.set(p.subarray(i, i + 3), i);
    flipped.set(p.subarray(i + 6, i + 9), i + 3);
    flipped.set(p.subarray(i + 3, i + 6), i + 6);
  }
  return { positions: flipped };
}

/** A binary STL of the triangles. The stored normals are computed from the corners. */
export function toBinaryStl({ positions: p }: TriangleSoup): Uint8Array<ArrayBuffer> {
  const count = p.length / 9;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length; ny /= length; nz /= length;
    const at = 84 + t * 50;
    view.setFloat32(at, nx, true);
    view.setFloat32(at + 4, ny, true);
    view.setFloat32(at + 8, nz, true);
    for (let k = 0; k < 9; k++) view.setFloat32(at + 12 + k * 4, p[i + k], true);
  }
  return bytes;
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
 * that is not shared by exactly two triangles. `stats.openEdges` receives how many edges are not shared by exactly two.
 */
export function toPartMesh(soup: TriangleSoup, creaseDegrees = 28, stats?: { openEdges: number }): Omit<PartMesh, 'volume' | 'quality' | 'reason'> {
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
  // Triangles that meet along an edge that is not drawn belong to one region, which the measure tool calls a face.
  const parent = Int32Array.from({ length: triangleCount }, (_, t) => t);
  const root = (t: number) => {
    while (parent[t] !== t) t = parent[t] = parent[parent[t]];
    return t;
  };
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
      else if (edge.count === 2) parent[root(other)] = root(t);
    }
  }
  const segments: number[] = [];
  if (stats) stats.openEdges = 0;
  for (const edge of edges.values()) {
    if (stats && edge.count !== 2) stats.openEdges++;
    if (edge.count === 2 && !edge.sharp) continue;
    const t = Math.floor(edge.first / 3);
    const k = edge.first % 3;
    const from = t * 9 + k * 3;
    const to = t * 9 + ((k + 1) % 3) * 3;
    segments.push(p[from], p[from + 1], p[from + 2], p[to], p[to + 1], p[to + 2]);
  }

  // Number the regions in the order their first triangle appears, over the triangles that are kept.
  const regionId = new Map<number, number>();
  const faceOf = new Uint32Array(kept);
  let next = 0;
  for (let t = 0, k = 0; t < triangleCount; t++) {
    if (!keep[t]) continue;
    const r = root(t);
    let id = regionId.get(r);
    if (id === undefined) regionId.set(r, id = next++);
    faceOf[k++] = id;
  }
  // Corners: the ends of the drawn edges, each once.
  const seen = new Map<string, number>();
  const corners: number[] = [];
  for (let i = 0; i < segments.length; i += 3) {
    const key = `${Math.round(segments[i] * weldScale)} ${Math.round(segments[i + 1] * weldScale)} ${Math.round(segments[i + 2] * weldScale)}`;
    if (seen.has(key)) continue;
    seen.set(key, corners.length / 3);
    corners.push(segments[i], segments[i + 1], segments[i + 2]);
  }

  return {
    positions: outPositions,
    normals,
    indices,
    edgeSegments: new Float32Array(segments),
    faceOf,
    edgeOf: new Uint32Array(0),
    corners: new Float64Array(corners),
    bounds: meshBounds({ positions: outPositions }),
  };
}

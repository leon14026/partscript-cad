import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { previewSolid } from '../src/engine/solid.ts';
import { toPartMesh } from '../src/engine/mesh.ts';

const kernel = await OcctKernel.init();
after(() => kernel.releaseAll());

/** A 40 x 30 x 5 plate with a hole of radius 4 at (10, 10), stored and re-read the way the build stores a part. */
function plate() {
  const hole = kernel.translate(kernel.makeCylinder(4, 5), 10, 10, 0);
  const cut = kernel.cut(kernel.makeBox(40, 30, 5), hole);
  return kernel.fromBREPBinary(kernel.toBREPBinary(kernel.getSubShapes(cut, 'solid')[0]));
}

function triangleArea(positions: Float32Array, indices: Uint32Array, t: number) {
  const p = (k: number) => [positions[indices[t * 3 + k] * 3], positions[indices[t * 3 + k] * 3 + 1], positions[indices[t * 3 + k] * 3 + 2]];
  const [a, b, c] = [p(0), p(1), p(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
}

test('the faces of an exact part are numbered in the order of getSubShapes, and each triangle knows its face', () => {
  const shape = plate();
  const mesh = previewSolid(kernel, shape);
  const faces = kernel.getSubShapes(shape, 'face');
  assert.equal(faces.length, 7, '6 sides of the plate and the wall of the hole');
  assert.equal(mesh.faceOf.length, mesh.indices.length / 3);
  const area = new Float64Array(faces.length);
  for (let t = 0; t < mesh.faceOf.length; t++) area[mesh.faceOf[t]] += triangleArea(mesh.positions, mesh.indices, t);
  faces.forEach((face, i) => {
    const exact = kernel.getSurfaceArea(face);
    assert.ok(Math.abs(area[i] - exact) < 2e-3 * exact, `face ${i}: triangles add up to ${area[i]}, the kernel says ${exact}`);
  });
  // Worked by hand: the hole wall is 2 pi 4 x 5, and the top and bottom lose pi 4^2.
  const wall = faces.findIndex((face) => kernel.surfaceType(face) === 'cylinder');
  assert.ok(Math.abs(kernel.getSurfaceArea(faces[wall]) - 2 * Math.PI * 4 * 5) < 1e-6);
  assert.ok(Math.abs(Math.max(...faces.map((face) => kernel.getSurfaceArea(face))) - (40 * 30 - Math.PI * 16)) < 1e-6);
});

test('the edges and corners of an exact part are numbered in the order of getSubShapes', () => {
  const shape = plate();
  const mesh = previewSolid(kernel, shape);
  const edges = kernel.getSubShapes(shape, 'edge');
  const vertices = kernel.getSubShapes(shape, 'vertex');
  assert.equal(edges.length, 15, '12 plate edges, 2 hole circles, 1 seam');
  assert.equal(mesh.edgeOf.length, mesh.edgeSegments.length / 6);
  assert.equal(mesh.corners.length, vertices.length * 3);
  const drawn = new Float64Array(edges.length);
  for (let s = 0; s < mesh.edgeOf.length; s++) {
    const at = mesh.edgeSegments.subarray(s * 6, s * 6 + 6);
    drawn[mesh.edgeOf[s]] += Math.hypot(at[3] - at[0], at[4] - at[1], at[5] - at[2]);
  }
  edges.forEach((edge, i) => {
    const exact = kernel.curveLength(edge);
    assert.ok(Math.abs(drawn[i] - exact) < 2e-3 * exact, `edge ${i}: segments add up to ${drawn[i]}, the kernel says ${exact}`);
  });
  vertices.forEach((vertex, i) => {
    const { x, y, z } = kernel.vertexPosition(vertex);
    assert.deepEqual([...mesh.corners.slice(i * 3, i * 3 + 3)], [x, y, z]);
  });
});

test('a faceted cube has six regions of two triangles and eight corners; a faceted cylinder wall is one region', () => {
  const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const sides = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const cube = toPartMesh({ positions: new Float32Array(sides.flatMap((side) => side.flatMap((i) => c[i]))) });
  assert.equal(cube.faceOf.length, 12);
  assert.equal(new Set(cube.faceOf).size, 6);
  const pairs = new Map<number, number>();
  for (const face of cube.faceOf) pairs.set(face, (pairs.get(face) ?? 0) + 1);
  assert.ok([...pairs.values()].every((count) => count === 2));
  assert.equal(cube.corners.length / 3, 8);
  assert.equal(cube.edgeOf.length, 0, 'a faceted part does not number its edges');

  // A 32-sided prism of radius 5 and height 10: 32 wall quads, two caps. 30 degree creases cannot split the wall (11.25 degrees apart).
  const n = 32;
  const ring = (z: number, k: number): number[] => [5 * Math.cos((2 * Math.PI * k) / n), 5 * Math.sin((2 * Math.PI * k) / n), z];
  const triangles: number[] = [];
  for (let k = 0; k < n; k++) {
    triangles.push(...ring(0, k), ...ring(0, k + 1), ...ring(10, k + 1), ...ring(0, k), ...ring(10, k + 1), ...ring(10, k));
    triangles.push(0, 0, 10, ...ring(10, k), ...ring(10, k + 1));
    triangles.push(0, 0, 0, ...ring(0, k + 1), ...ring(0, k));
  }
  const prism = toPartMesh({ positions: new Float32Array(triangles) });
  assert.equal(new Set(prism.faceOf).size, 3, 'wall, top and bottom');
});

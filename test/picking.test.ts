import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import type { Matrix } from '../src/engine/assembly.ts';
import type { PartMesh, Vec3 } from '../src/engine/protocol.ts';
import { previewSolid } from '../src/engine/solid.ts';
import { castRay, pickAt, toScreen, viewRay, type PickPart, type PickView } from '../src/picking.ts';

const kernel = await OcctKernel.init();
after(() => kernel.releaseAll());

const identity: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** The 40 x 30 x 5 plate with a hole of radius 4 at (10, 10), as the build stores a part. */
function plate(): PartMesh {
  const hole = kernel.translate(kernel.makeCylinder(4, 5), 10, 10, 0);
  const cut = kernel.cut(kernel.makeBox(40, 30, 5), hole);
  const shape = kernel.fromBREPBinary(kernel.toBREPBinary(kernel.getSubShapes(cut, 'solid')[0]));
  return { ...previewSolid(kernel, shape), volume: 0, quality: 'exact' };
}

/** 10 pixels to the model unit, the plate's centre (20, 15, 2.5) in the middle of a 600 x 600 canvas. */
function lookingAlong(forward: Vec3, right: Vec3, up: Vec3): PickView {
  const norm = (v: Vec3): Vec3 => v.map((c) => c / Math.hypot(...v)) as Vec3;
  const [f, r, u] = [norm(forward), norm(right), norm(up)];
  return { origin: [20 - f[0] * 200, 15 - f[1] * 200, 2.5 - f[2] * 200], right: r, up: u, forward: f, scale: 10, cx: 300, cy: 300 };
}

const fromAbove = lookingAlong([0, 0, -1], [1, 0, 0], [0, 1, 0]);
// Looking down and toward +y: the front (y = 0) face is seen, the back bottom edge is hidden.
const tilted = lookingAlong([0, 1, -2], [1, 0, 0], [0, 2, 1]);

const part = (mesh: PartMesh, matrix = identity): PickPart => ({ mesh, matrix, visible: true });
const at = (view: PickView, p: Vec3) => toScreen(view, p).slice(0, 2);

test('screen and ray are each other\'s inverse', () => {
  const [x, y, depth] = toScreen(tilted, [31, 7, 3]);
  const { origin, dir } = viewRay(tilted, x, y);
  const back = [origin[0] + dir[0] * depth, origin[1] + dir[1] * depth, origin[2] + dir[2] * depth];
  [31, 7, 3].forEach((c, i) => assert.ok(Math.abs(back[i] - c) < 1e-9));
});

test('a ray finds the same nearest triangle as testing every triangle', () => {
  const mesh = plate();
  const parts = [part(mesh)];
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  let hits = 0;
  for (let n = 0; n < 300; n++) {
    const target: Vec3 = [random() * 50 - 5, random() * 40 - 5, random() * 7 - 1];
    const dir: Vec3 = [random() - 0.5, random() - 0.5, random() - 1.2];
    const length = Math.hypot(...dir);
    const unitDir = dir.map((c) => c / length) as Vec3;
    const origin: Vec3 = [target[0] - unitDir[0] * 100, target[1] - unitDir[1] * 100, target[2] - unitDir[2] * 100];
    // Reference: every triangle, Moller-Trumbore, both sides.
    let best = Infinity;
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const p = (k: number) => [0, 1, 2].map((axis) => mesh.positions[mesh.indices[t * 3 + k] * 3 + axis]);
      const [a, b, c] = [p(0), p(1), p(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const pv = [unitDir[1] * e2[2] - unitDir[2] * e2[1], unitDir[2] * e2[0] - unitDir[0] * e2[2], unitDir[0] * e2[1] - unitDir[1] * e2[0]];
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-12) continue;
      const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
      const u = (s[0] * pv[0] + s[1] * pv[1] + s[2] * pv[2]) / det;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = (unitDir[0] * q[0] + unitDir[1] * q[1] + unitDir[2] * q[2]) / det;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      const t0 = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (t0 > 0 && t0 < best) best = t0;
    }
    const found = castRay(parts, origin, unitDir);
    if (best === Infinity) assert.equal(found, undefined, `ray ${n}`);
    else {
      assert.ok(found, `ray ${n} should hit at ${best}`);
      assert.ok(Math.abs(found.t - best) < 1e-5, `ray ${n}: ${found.t} against ${best}`);
      hits++;
    }
  }
  assert.ok(hits > 100, 'the rays do cross the plate');
});

test('the pointer over the plate picks the top face, and over nothing picks nothing', () => {
  const mesh = plate();
  const hit = pickAt([part(mesh)], fromAbove, ...(at(fromAbove, [30, 20, 5]) as [number, number]))!;
  assert.equal(hit.type, 'face');
  // That face is the large plane of the top, normal +z: any triangle of it has +z normals and the area worked by hand.
  const triangles = [...mesh.faceOf].flatMap((face, t) => (face === hit.index ? [t] : []));
  assert.ok(triangles.length > 10);
  assert.ok(triangles.every((t) => mesh.normals[mesh.indices[t * 3] * 3 + 2] > 0.99), 'every triangle of the face points up');
  assert.deepEqual(hit.point.map((c) => Math.round(c * 1e6) / 1e6), [30, 20, 5]);
  assert.equal(pickAt([part(mesh)], fromAbove, 5, 5), undefined, 'the pointer is over nothing');
});

test('a corner wins within 8 px, an edge within 6 px, and neither wins when it is farther', () => {
  const mesh = plate();
  const parts = [part(mesh)];
  const [cornerX, cornerY] = at(fromAbove, [0, 0, 5]);
  const corner = pickAt(parts, fromAbove, cornerX + 5, cornerY - 3)!;
  assert.equal(corner.type, 'vertex');
  assert.deepEqual([...mesh.corners.slice(corner.index * 3, corner.index * 3 + 3)], [0, 0, 5]);
  // 4 px outside the long front edge (y = 0, z = 5), halfway along it.
  const [edgeX, edgeY] = at(fromAbove, [20, 0, 5]);
  const edge = pickAt(parts, fromAbove, edgeX, edgeY + 4)!;
  assert.equal(edge.type, 'edge');
  for (let s = 0; s < mesh.edgeOf.length; s++) {
    if (mesh.edgeOf[s] !== edge.index) continue;
    // Every drawn piece of the picked edge lies on the line y = 0, z = 5 or z = 0 (the same line from above).
    assert.ok(Math.abs(mesh.edgeSegments[s * 6 + 1]) < 1e-6 && Math.abs(mesh.edgeSegments[s * 6 + 4]) < 1e-6);
  }
  // 9 px outside the edge is the background.
  assert.equal(pickAt(parts, fromAbove, edgeX, edgeY + 9), undefined);
  // 9 px inside the edge is the face.
  assert.equal(pickAt(parts, fromAbove, edgeX, edgeY - 9)?.type, 'face');
  // A circular edge of the hole.
  // Not at the seam of the circle, which has a corner of its own.
  const [rimX, rimY] = at(fromAbove, [10, 14, 5]);
  const rim = pickAt(parts, fromAbove, rimX, rimY + 3)!;
  assert.equal(rim.type, 'edge');
});

test('an edge behind the plate cannot be picked, and a hidden part cannot be hit', () => {
  const mesh = plate();
  // Seen from above and the front, the bottom edge at the back (y = 30, z = 0) lies behind the plate.
  const [x, y] = at(tilted, [20, 30, 0]);
  const hidden = pickAt([part(mesh)], tilted, x, y);
  assert.notEqual(hidden?.type, 'edge');
  // The bottom edge at the front (y = 0, z = 0) is in plain sight.
  const [fx, fy] = at(tilted, [20, 0, 0]);
  assert.equal(pickAt([part(mesh)], tilted, fx, fy)?.type, 'edge');

  const [px, py] = at(fromAbove, [30, 20, 5]);
  assert.equal(pickAt([{ ...part(mesh), visible: false }], fromAbove, px, py), undefined);
  // A second plate moved 20 above the first hides it, and is the one that is hit.
  const lifted = part(mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 20]);
  const hit = pickAt([part(mesh), lifted], fromAbove, px, py)!;
  assert.equal(hit.part, 1);
  assert.ok(Math.abs(hit.point[2] - 25) < 1e-6);
});

test('picking follows a part that a joint has turned', () => {
  const mesh = plate();
  // Turned 90 degrees about z, then moved 100 along x: the plate's (40, 0) corner is at (100, 40).
  const turned: Matrix = [0, -1, 0, 100, 1, 0, 0, 0, 0, 0, 1, 0];
  const [x, y] = at(fromAbove, [100, 40, 5]);
  const hit = pickAt([part(mesh, turned)], fromAbove, x, y)!;
  assert.equal(hit.type, 'vertex');
  assert.deepEqual([...mesh.corners.slice(hit.index * 3, hit.index * 3 + 3)], [40, 0, 5]);
});

test('a large mesh is picked quickly after its hierarchy is built', () => {
  // A 300 x 300 grid of quads: 180 000 triangles.
  const n = 300;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) positions.set([i, j, Math.sin(i / 7) * Math.cos(j / 9)], (j * (n + 1) + i) * 3);
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      indices.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], k);
      k += 6;
    }
  }
  const mesh: PartMesh = {
    positions, normals: new Float32Array(positions.length), indices, edgeSegments: new Float32Array(0), faceOf: new Uint32Array(n * n * 2),
    edgeOf: new Uint32Array(0), corners: new Float64Array(0), bounds: { min: [0, 0, -1], max: [n, n, 1] }, volume: 0, quality: 'faceted',
  };
  const parts = [part(mesh)];
  const started = performance.now();
  assert.ok(castRay(parts, [150.5, 150.5, 50], [0, 0, -1]));
  const built = performance.now() - started;
  const again = performance.now();
  for (let r = 0; r < 500; r++) assert.ok(castRay(parts, [(r % 290) + 5.5, ((r * 7) % 290) + 5.5, 50], [0, 0, -1]));
  const each = (performance.now() - again) / 500;
  console.log(`# hierarchy of 180000 triangles: ${built.toFixed(0)} ms, then ${each.toFixed(3)} ms a ray`);
  assert.ok(each < 1, `${each} ms a ray is too slow`);
});

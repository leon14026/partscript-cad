import assert from 'node:assert/strict';
import test from 'node:test';
import { hasShapes, parseCsg, unsupported } from '../src/engine/csg.ts';
import { meshBounds, meshVolume, parseBinaryStl, toPartMesh, type TriangleSoup } from '../src/engine/mesh.ts';
import { flattenGroups } from '../src/engine/scad.ts';

function near(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

/** A unit cube as 12 triangles, outward facing. */
function unitCube(): TriangleSoup {
  const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { positions: new Float32Array(faces.flatMap((face) => face.flatMap((i) => c[i]))) };
}

function binaryStl(soup: TriangleSoup) {
  const count = soup.positions.length / 9;
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, count, true);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 9; k++) view.setFloat32(84 + t * 50 + 12 + k * 4, soup.positions[t * 9 + k], true);
  }
  return bytes;
}

test('a hand-written cube has volume 1, 12 feature edges and exact bounds', () => {
  const soup = unitCube();
  near(meshVolume(soup), 1);
  assert.deepEqual(meshBounds(soup), { min: [0, 0, 0], max: [1, 1, 1] });
  const mesh = toPartMesh(soup);
  assert.equal(mesh.indices.length, 36);
  assert.equal(mesh.positions.length, 108);
  assert.equal(mesh.edgeSegments.length / 6, 12, 'the 6 diagonals lie in a face and are not drawn');
  // Flat shading: the first triangle is the bottom face and points down.
  assert.deepEqual([...mesh.normals.slice(0, 3)], [0, 0, -1]);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [1, 1, 1] });
});

test('a binary STL reads back to the same triangles, and a short file is refused', () => {
  const soup = unitCube();
  const back = parseBinaryStl(binaryStl(soup));
  assert.deepEqual([...back.positions], [...soup.positions]);
  assert.throws(() => parseBinaryStl(new Uint8Array(10)), /too short/);
  assert.throws(() => parseBinaryStl(binaryStl(soup).slice(0, 200)), /ends early/);
});

test('a smooth ring of facets draws no edges between neighbours, and a loose triangle draws all three', () => {
  // A 64-sided prism: neighbouring side faces differ by 5.6 degrees, so only the two end caps show edges.
  const n = 64;
  const triangles: number[] = [];
  const ring = (i: number, z: number) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n), z];
  for (let i = 0; i < n; i++) {
    const [a, b] = [ring(i, 0), ring(i + 1, 0)];
    const [c, d] = [ring(i, 1), ring(i + 1, 1)];
    triangles.push(...a, ...b, ...d, ...a, ...d, ...c);
    triangles.push(0, 0, 0, ...b, ...a, 0, 0, 1, ...c, ...d);
  }
  const prism = toPartMesh({ positions: new Float32Array(triangles) });
  assert.equal(prism.edgeSegments.length / 6, 2 * n, 'one circle of 64 segments at each end');
  const loose = toPartMesh({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  assert.equal(loose.edgeSegments.length / 6, 3);
});

test('triangles with no area are dropped from the picture', () => {
  const soup = unitCube();
  const withSliver = { positions: new Float32Array([...soup.positions, 2, 2, 2, 2, 2, 2, 3, 3, 3]) };
  const mesh = toPartMesh(withSliver);
  assert.equal(mesh.indices.length, 36);
});

test('the CSG reader records offsets, reads strings and undef, and drops background shapes', () => {
  const dump = `cube(size = [1, 1, 1], center = false);
%multmatrix([[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
\tcube(size = [9, 9, 9], center = false);
}
#sphere($fn = 0, $fa = 12, $fs = 2, r = 1);
text(text = "A\\"b", size = 10, font = undef);
`;
  const nodes = parseCsg(dump);
  assert.deepEqual(nodes.map((node) => node.operation), ['cube', 'sphere', 'text']);
  assert.equal(dump.slice(nodes[0].start, nodes[0].end), 'cube(size = [1, 1, 1], center = false);');
  assert.equal(dump.slice(nodes[1].start, nodes[1].end), '#sphere($fn = 0, $fa = 12, $fs = 2, r = 1);');
  assert.equal(nodes[2].named.get('text'), 'A"b');
  assert.equal(nodes[2].named.get('font'), null);
  assert.equal(hasShapes(parseCsg('%cube(size = [1, 1, 1], center = false);')), false);
  assert.equal(hasShapes(parseCsg('square(size = [1, 1], center = false);')), true);
});

test('long lists such as a polyhedron are read in full', () => {
  const points = Array.from({ length: 5000 }, (_, i) => `[${i}, 0, 0]`).join(', ');
  const [node] = parseCsg(`polyhedron(points = [${points}], faces = [[0, 1, 2]], convexity = 1);`);
  assert.equal((node.named.get('points') as unknown[]).length, 5000);
});

test('unsupported() names the first operation the exact builder lacks', () => {
  const name = (dump: string) => unsupported(parseCsg(dump));
  assert.equal(name('cube(size = [1, 1, 1], center = false);'), undefined);
  assert.equal(name('difference() { cube(size = [2, 2, 2], center = false); cylinder($fn = 0, $fa = 4, $fs = 0.5, h = 3, r1 = 1, r2 = 1, center = false); }'), undefined);
  assert.equal(name('color([1, 0, 0, 1]) { render(convexity = 3) { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); } }'), undefined);
  assert.equal(name('group() { hull() { cube(size = [1, 1, 1], center = false); } }'), 'hull');
  // An extrusion is exact when its whole 2D shape is, and a prism from $fn when the radii are equal.
  assert.equal(name('linear_extrude(height = 5) { square(size = [4, 3], center = false); }'), undefined);
  assert.equal(name('linear_extrude(height = 5, center = false, twist = 30, slices = 4, scale = [1, 1]) { square(size = [4, 3], center = false); }'), 'linear_extrude with twist');
  assert.equal(name('linear_extrude(height = 5) { text(); }'), 'text');
  assert.equal(name('cylinder($fn = 6, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 6, center = false);'), undefined);
  assert.equal(name('cylinder($fn = 6, $fa = 12, $fs = 2, h = 5, r1 = 6, r2 = 3, center = false);'), 'cylinder with $fn');
  assert.equal(name('multmatrix([[1, 0, 0, 0], [0, 2, 0, 0], [0, 0, 3, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }'), undefined);
  assert.equal(name('multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }'), undefined);
  assert.equal(name('multmatrix([[1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 3, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }'), 'scale');
  assert.equal(name('multmatrix([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }'), 'multmatrix');
  // A mirror is still rigid.
  assert.equal(name('multmatrix([[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }'), undefined);
});

test('flattenGroups removes a group that holds one shape and keeps every other', () => {
  const dump = [
    'group() {',
    '\tgroup() {',
    '\t\tgroup() {',
    '\t\t\tcube(size = [1, 1, 1], center = false);',
    '\t\t}',
    '\t}',
    '\tgroup() {',
    '\t\tsphere($fn = 0, $fa = 12, $fs = 2, r = 1);',
    '\t\tcube(size = [2, 2, 2], center = false);',
    '\t}',
    '}',
  ].join('\n');
  // The root holds two children, so it stays; the single-child chain around the first cube goes.
  assert.equal(flattenGroups(dump), [
    'group() {',
    '\t\t\tcube(size = [1, 1, 1], center = false);',
    '\tgroup() {',
    '\t\tsphere($fn = 0, $fa = 12, $fs = 2, r = 1);',
    '\t\tcube(size = [2, 2, 2], center = false);',
    '\t}',
    '}',
  ].join('\n'));
  // Other nodes with one child are not groups and stay, and so does a group that is not alone.
  const kept = 'difference() {\n\tmultmatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\t\tcube(size = [1, 1, 1], center = false);\n\t}\n}';
  assert.equal(flattenGroups(kept), kept);
  // A dump whose braces do not balance is returned as it came.
  assert.equal(flattenGroups('group() {\n\tgroup() {\n\t\tcube(1);\n\t}'), 'group() {\n\tgroup() {\n\t\tcube(1);\n\t}');
  assert.equal(flattenGroups('}\ngroup() {'), '}\ngroup() {');
});

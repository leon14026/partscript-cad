import type { EdgeData, OcctKernel, ShapeHandle } from 'occt-wasm';
import { type CsgNode, moveKind, parseCsg } from './csg.ts';
import { extrudeFlat, regularPrism } from './extrude.ts';
import { extrusion, isNothing } from './flat.ts';
import type { AssemblySpec, Matrix } from './assembly.ts';
import { maxTriangles } from './mesh.ts';
import { CadError, type PartMesh, type Vec3 } from './protocol.ts';

const minLength = 0.0001;
const maxLength = 1_000_000;

type ShapeResult = ShapeHandle | null;

function length(value: unknown, label: string, allowZero = false) {
  if (value === 0 && allowZero) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minLength || value > maxLength) {
    throw new CadError(`${label} must be between ${minLength} and ${maxLength.toLocaleString('en-US')} mm.`);
  }
  return value;
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(a: Vec3): Vec3 {
  const norm = Math.hypot(...a);
  return [a[0] / norm, a[1] / norm, a[2] / norm];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * The 3x4 matrix for kernel.transform. OpenSCAD writes six significant digits, so
 * restore right angles between the axes first, then apply the scale factor.
 */
function placement(input: unknown, factor = 1) {
  const [x, y, z] = input as number[][];
  const a: Vec3 = [x[0], y[0], z[0]];
  const b: Vec3 = [x[1], y[1], z[1]];
  const c: Vec3 = [x[2], y[2], z[2]];
  if ([x[3], y[3], z[3]].some((value) => Math.abs(value) > maxLength)) {
    throw new CadError('A translation exceeds the supported coordinate range.');
  }

  const u = unit(a);
  const projection = dot(u, b);
  const v = unit([b[0] - projection * u[0], b[1] - projection * u[1], b[2] - projection * u[2]]);
  const normal = cross(u, v);
  const handedness = Math.sign(dot(normal, c));
  return [u[0] * factor, v[0] * factor, normal[0] * handedness * factor, x[3],
    u[1] * factor, v[1] * factor, normal[1] * handedness * factor, y[3],
    u[2] * factor, v[2] * factor, normal[2] * handedness * factor, z[3]];
}

/** The drawn segments of every edge, and the number of the edge each segment belongs to. */
function edgeSegments({ points, edgeGroups }: EdgeData) {
  let segments = 0;
  for (let i = 1; i < edgeGroups.length; i += 3) segments += Math.max(0, edgeGroups[i] / 3 - 1);
  const lines = new Float32Array(segments * 6);
  const edgeOf = new Uint32Array(segments);
  let offset = 0;
  for (let i = 0; i < edgeGroups.length; i += 3) {
    const first = edgeGroups[i];
    const end = first + edgeGroups[i + 1];
    for (let j = first; j + 3 < end; j += 3) {
      lines.set(points.subarray(j, j + 6), offset);
      edgeOf[offset / 6] = i / 3;
      offset += 6;
    }
  }
  return { lines, edgeOf };
}

export function buildSolid(kernel: OcctKernel, csg: string | CsgNode[]) {
  function solidOrEmpty(shape: ShapeHandle): ShapeHandle | null {
    return !kernel.isNull(shape) && kernel.subShapeCount(shape, 'solid') > 0 ? shape : null;
  }

  function fuse(shapes: ShapeResult[]): ShapeResult {
    const solids = shapes.filter((shape): shape is ShapeHandle => shape !== null);
    if (!solids.length) return null;
    if (solids.length === 1) return solids[0];
    return solidOrEmpty(kernel.fuseAll(solids));
  }

  function build(node: CsgNode): ShapeResult {
    const { operation, named, positional, children } = node;
    switch (operation) {
      case 'group':
      case 'union':
      case 'color':
      case 'render':
        return fuse(children.map(build));
      case 'difference': {
        const [base, ...tools] = children.map(build);
        if (base == null) return null;
        const cuts = tools.filter((shape): shape is ShapeHandle => shape !== null);
        return cuts.length ? solidOrEmpty(kernel.cutAll(base, cuts)) : base;
      }
      case 'intersection': {
        const [base, ...tools] = children.map(build);
        let result: ShapeResult = base ?? null;
        for (const tool of tools) {
          if (result == null || tool === null) return null;
          result = solidOrEmpty(kernel.intersect(result, tool));
        }
        return result;
      }
      case 'multmatrix': {
        const move = moveKind(positional[0]);
        if (move.kind === 'invalid') throw new CadError('The model contains an invalid transformation matrix.');
        if (move.kind === 'other') throw new CadError('A scale of zero or less, or a shear, has to be built from a mesh.');
        const [x, y, z] = positional[0] as number[][];
        const child = fuse(children.map(build));
        if (child == null) return child;
        // Equal factors keep flat faces flat. Different factors turn every face into a spline surface.
        if (move.kind === 'axes') {
          if ([x[3], y[3], z[3]].some((value) => Math.abs(value) > maxLength)) throw new CadError('A translation exceeds the supported coordinate range.');
          const [fx, fy, fz] = move.factors;
          return kernel.generalTransform(child, [fx, 0, 0, x[3], 0, fy, 0, y[3], 0, 0, fz, z[3]]);
        }
        return kernel.transform(child, placement(positional[0], move.kind === 'uniform' ? move.factor : 1));
      }
      case 'linear_extrude': {
        const found = extrusion(node);
        if ('reason' in found) throw new CadError(`linear_extrude() has to be built from a mesh: ${found.reason}.`);
        if (isNothing(found.flat)) return null;
        const height = length(found.height, 'Extrusion height');
        const shape = extrudeFlat(kernel, found.flat, height);
        return shape !== null && found.center ? kernel.translate(shape, 0, 0, -height / 2) : shape;
      }
      case 'cube': {
        const size = named.get('size');
        if (!Array.isArray(size) || size.length !== 3) throw new CadError('cube() needs three valid dimensions.');
        const [dx, dy, dz] = size.map((value) => length(value, 'Box size'));
        const shape = kernel.makeBox(dx, dy, dz);
        return named.get('center') === true ? kernel.translate(shape, -dx / 2, -dy / 2, -dz / 2) : shape;
      }
      case 'sphere':
      case 'cylinder': {
        // Smooth at any $fa and $fs. Only $fn above zero asks for facets. Equal radii then make a regular prism, and unsupported() sends the rest to the mesh path.
        const sides = named.get('$fn') ?? 0;
        if (typeof sides !== 'number' || (sides !== 0 && (operation === 'sphere' || named.get('r1') !== named.get('r2')))) {
          throw new CadError(`${operation}() with $fn has to be built from a mesh.`);
        }
        if (operation === 'sphere') return kernel.makeSphere(length(named.get('r'), 'Sphere radius'));
        const height = length(named.get('h'), 'Cylinder height');
        if (sides !== 0) {
          const prism = regularPrism(kernel, Math.max(3, Math.trunc(sides)), length(named.get('r1'), 'Cylinder radius'), height);
          return named.get('center') === true ? kernel.translate(prism, 0, 0, -height / 2) : prism;
        }
        const bottom = length(named.get('r1'), 'Bottom radius', true);
        const top = length(named.get('r2'), 'Top radius', true);
        if (bottom === 0 && top === 0) throw new CadError('A cylinder or cone needs at least one positive radius.');
        const shape = bottom === top ? kernel.makeCylinder(bottom, height) : kernel.makeCone(bottom, top, height);
        return named.get('center') === true ? kernel.translate(shape, 0, 0, -height / 2) : shape;
      }
      default:
        throw new CadError(`${operation}() has to be built from a mesh.`);
    }
  }

  const nodes = typeof csg === 'string' ? parseCsg(csg) : csg;
  let shape = fuse(nodes.map(build));
  if (shape == null) throw new CadError('This model has no solid volume. Check the dimensions and Boolean operations.');
  const count = kernel.subShapeCount(shape, 'solid');
  if (count < 1) throw new CadError('This model has no solid volume. Check the dimensions and Boolean operations.');
  // A part can hold several separate bodies. They stay together as one compound.
  if (count > 1) shape = kernel.makeCompound(kernel.getSubShapes(shape, 'solid'));
  else if (!kernel.isSolid(shape)) [shape] = kernel.getSubShapes(shape, 'solid');
  if (!kernel.isValid(shape)) throw new CadError('The model is not a valid solid. Check for touching edges and overlapping features.');
  const volume = kernel.getVolume(shape);
  if (!Number.isFinite(volume) || volume <= 0) throw new CadError('This model has no positive solid volume.');
  return { shape, volume };
}

/**
 * How finely an imported solid is meshed, from how many faces it has. OpenCascade meshes about 9,000 triangles a
 * second in the browser, and its angular tolerance sets how many triangles a round face gets, so a part with
 * thousands of faces is meshed more coarsely to stay well inside the 60 second job. A part made here has a few
 * hundred faces at most and is always meshed finely. Measured: a plate with 1,800 faces and 1,200 holes took 38 s
 * at 0.18 radians (338,000 triangles), 8.5 s at 0.5 (127,000) and 3.6 s at 0.8 (79,000).
 * (A second pass at a coarser setting does nothing: OpenCascade keeps the first mesh of a shape.)
 */
export function importedMeshing(faces: number) {
  if (faces <= 400) return { angular: 0.18, factor: 1 };
  if (faces <= 1_000) return { angular: 0.3, factor: 2 };
  if (faces <= 4_000) return { angular: 0.5, factor: 3 };
  return { angular: 0.8, factor: 4 };
}

export function previewSolid(kernel: OcctKernel, shape: ShapeHandle, imported = false): Omit<PartMesh, 'volume' | 'quality' | 'reason'> {
  const { xmin, ymin, zmin, xmax, ymax, zmax } = kernel.getBoundingBox(shape);
  const min: Vec3 = [xmin, ymin, zmin];
  const max: Vec3 = [xmax, ymax, zmax];
  if ([...min, ...max].some((value) => !Number.isFinite(value) || Math.abs(value) > maxLength)) {
    throw new CadError('The model exceeds the supported coordinate range.');
  }
  const span = Math.max(xmax - xmin, ymax - ymin, zmax - zmin);
  const { angular, factor } = imported ? importedMeshing(kernel.subShapeCount(shape, 'face')) : { angular: 0.18, factor: 1 };
  const deflection = Math.max(span / 1_200, 0.00001) * factor;
  // meshShape also reports which triangles belong to which face. The faces come in the order of
  // getSubShapes(shape, 'face'), which the measure command relies on (test/measure.test.ts checks it).
  const mesh = kernel.meshShape(shape, { linearDeflection: deflection, angularDeflection: angular });
  if (!mesh.triangleCount || mesh.triangleCount > maxTriangles) {
    throw new CadError(mesh.triangleCount
      ? `The solid is too complex to preview: ${mesh.triangleCount.toLocaleString('en-US')} triangles, and the limit is ${maxTriangles.toLocaleString('en-US')}. Reduce the number of features, or export a simpler version of an imported file.`
      : 'The solid is too complex to preview. Reduce the number of features.');
  }
  const faceOf = new Uint32Array(mesh.triangleCount);
  const groups = mesh.faceGroups ?? new Int32Array(0);
  // A group is [first index, number of indices, hash]: three indices to a triangle.
  for (let i = 0; i < groups.length; i += 3) faceOf.fill(i / 3, groups[i] / 3, (groups[i] + groups[i + 1]) / 3);
  const edgeData = kernel.wireframe(shape, { source: 'triangulation', deflection });
  const { lines, edgeOf } = edgeSegments(edgeData);
  const mark = kernel.checkpoint();
  const vertices = kernel.getSubShapes(shape, 'vertex');
  const corners = new Float64Array(vertices.length * 3);
  vertices.forEach((vertex, i) => {
    const { x, y, z } = kernel.vertexPosition(vertex);
    corners.set([x, y, z], i * 3);
  });
  kernel.releaseSince(mark);
  return {
    positions: new Float32Array(mesh.positions),
    normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.indices),
    edgeSegments: lines,
    faceOf,
    edgeOf,
    corners,
    bounds: { min, max },
  };
}

export function writeStep(kernel: OcctKernel, solid: ShapeHandle) {
  const data = kernel.exportStep(solid, { unit: 'mm', schema: 'AP214' });
  if (!data.startsWith('ISO-10303-21;') || !/\b(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\s*\(/.test(data)) {
    throw new CadError('The STEP writer did not return a solid.');
  }
  return new TextEncoder().encode(data);
}

/**
 * Turn the STL mesh of a faceted part into a solid with flat faces, for STEP.
 * Sews the triangles into shells, makes a solid from each shell, then merges
 * triangles that lie in one plane. The caller owns the returned handle. Throws
 * when the mesh does not close into solids, or when their volume is more than
 * 0.1% away from the mesh's.
 *
 * sewAndSolidify is not used: it returns no solid at all when the mesh holds
 * more than one body, which any assembly drawn as one part does.
 */
export function meshToSolid(kernel: OcctKernel, stl: Uint8Array, meshVolume: number, file: string): ShapeHandle {
  const mark = kernel.checkpoint();
  let brep: Uint8Array | undefined;
  try {
    const faces = kernel.getSubShapes(kernel.importStl(stl), 'face');
    const shells = kernel.getSubShapes(kernel.sew(faces, 1e-4), 'shell');
    const solids = shells.map((shell) => kernel.makeSolid(shell));
    if (solids.length) {
      const bodies = kernel.getSubShapes(kernel.unifySameDomain(kernel.makeCompound(solids)), 'solid');
      const shape = bodies.length === 1 ? bodies[0] : kernel.makeCompound(bodies);
      const volume = kernel.getVolume(shape);
      if (bodies.length && kernel.isValid(shape) && Math.abs(volume - meshVolume) <= 0.001 * meshVolume) {
        brep = kernel.toBREPBinary(shape);
      }
    }
  } catch {
    brep = undefined;
  } finally {
    kernel.releaseSince(mark);
  }
  if (!brep) {
    throw new CadError(`${file} could not be turned into a solid for STEP. It may have faces that touch only along an edge.`, undefined, file);
  }
  return kernel.fromBREPBinary(brep);
}

function isIdentity(matrix: Matrix) {
  return matrix.every((value, i) => Math.abs(value - (i % 5 === 0 ? 1 : 0)) < 1e-12);
}

/**
 * Write the posed assembly as a STEP product structure: one named, coloured
 * component per part. Parts built from the same file share one definition.
 */
export function writeAssemblyStep(kernel: OcctKernel, name: string, assembly: AssemblySpec, solids: ShapeHandle[], matrices: Matrix[]) {
  if (assembly.parts.length === 1 && isIdentity(matrices[0])) return writeStep(kernel, solids[0]);

  const mark = kernel.checkpoint();
  const document = kernel.createXCAFDocument();
  try {
    // A location tags the shared solid instead of copying it.
    const placed = solids.map((solid, i) => kernel.located(solid, matrices[i]));
    const root = document.addShape(kernel.makeCompound(placed), { assembly: true, name });
    const components = document.getChildren(root);
    if (components.length !== assembly.parts.length) throw new CadError('The STEP writer did not keep every part.');
    components.forEach((component, i) => {
      const part = assembly.parts[i];
      document.setName(component, part.name);
      const definition = document.getReferredLabel(component);
      if (definition != null) {
        document.setName(definition, part.file ? part.file.replace(/\.scad$/i, '') : part.name);
        document.setColor(definition, part.color);
      }
      document.setColor(component, part.color);
    });
    const data = document.exportSTEP({ unit: 'mm', schema: 'AP214' });
    if (!data.startsWith('ISO-10303-21;') || !/\bNEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/.test(data)) {
      throw new CadError('The STEP writer did not return an assembly.');
    }
    return new TextEncoder().encode(data);
  } finally {
    document.close();
    kernel.releaseSince(mark);
  }
}

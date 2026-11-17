import type { EdgeData, OcctKernel, ShapeHandle } from 'occt-wasm';
import { type CsgNode, parseCsg } from './csg.ts';
import type { AssemblySpec, Matrix } from './assembly.ts';
import { CadError, type Vec3 } from './protocol.ts';

const minLength = 0.0001;
const maxLength = 1_000_000;
const maxTriangles = 500_000;

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

function rigidMatrix(input: unknown) {
  const valid = Array.isArray(input) && input.length === 4 && input.every((row) =>
    Array.isArray(row) && row.length === 4 && row.every((value) => typeof value === 'number' && Number.isFinite(value)));
  if (!valid) throw new CadError('The model contains an invalid transformation matrix.');
  const [x, y, z, w] = input as number[][];
  const a: Vec3 = [x[0], y[0], z[0]];
  const b: Vec3 = [x[1], y[1], z[1]];
  const c: Vec3 = [x[2], y[2], z[2]];
  const tolerance = 0.000004;
  const residuals = [dot(a, a) - 1, dot(b, b) - 1, dot(c, c) - 1, dot(a, b), dot(a, c), dot(b, c)];
  if (w[0] !== 0 || w[1] !== 0 || w[2] !== 0 || w[3] !== 1 || residuals.some((r) => Math.abs(r) > tolerance)) {
    throw new CadError('Only translations, rotations and mirrors are supported. Set dimensions on the primitive to resize it.');
  }
  if ([x[3], y[3], z[3]].some((value) => Math.abs(value) > maxLength)) {
    throw new CadError('A translation exceeds the supported coordinate range.');
  }

  // OpenSCAD writes six significant digits. Restore orthogonality before applying a rigid transform.
  const u = unit(a);
  const projection = dot(u, b);
  const v = unit([b[0] - projection * u[0], b[1] - projection * u[1], b[2] - projection * u[2]]);
  const normal = cross(u, v);
  const handedness = Math.sign(dot(normal, c));
  return [u[0], v[0], normal[0] * handedness, x[3],
    u[1], v[1], normal[1] * handedness, y[3],
    u[2], v[2], normal[2] * handedness, z[3]];
}

function edgeSegments({ points, edgeGroups }: EdgeData) {
  let segments = 0;
  for (let i = 1; i < edgeGroups.length; i += 3) segments += Math.max(0, edgeGroups[i] / 3 - 1);
  const lines = new Float32Array(segments * 6);
  let offset = 0;
  for (let i = 0; i < edgeGroups.length; i += 3) {
    const first = edgeGroups[i];
    const end = first + edgeGroups[i + 1];
    for (let j = first; j + 3 < end; j += 3) {
      lines.set(points.subarray(j, j + 6), offset);
      offset += 6;
    }
  }
  return lines;
}

export function buildSolid(kernel: OcctKernel, csg: string) {
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
        const matrix = rigidMatrix(positional[0]);
        const child = fuse(children.map(build));
        return child == null ? child : kernel.transform(child, matrix);
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
        if (named.get('$fn') !== 0 || named.get('$fa') !== 12 || named.get('$fs') !== 2) {
          throw new CadError('Remove the facet override. This version builds smooth curves for STEP.');
        }
        if (operation === 'sphere') return kernel.makeSphere(length(named.get('r'), 'Sphere radius'));
        const height = length(named.get('h'), 'Cylinder height');
        const bottom = length(named.get('r1'), 'Bottom radius', true);
        const top = length(named.get('r2'), 'Top radius', true);
        if (bottom === 0 && top === 0) throw new CadError('A cylinder or cone needs at least one positive radius.');
        const shape = bottom === top ? kernel.makeCylinder(bottom, height) : kernel.makeCone(bottom, top, height);
        return named.get('center') === true ? kernel.translate(shape, 0, 0, -height / 2) : shape;
      }
    }
  }

  const nodes = parseCsg(csg);
  let shape = fuse(nodes.map(build));
  if (shape == null) throw new CadError('This model has no solid volume. Check the dimensions and Boolean operations.');
  const count = kernel.subShapeCount(shape, 'solid');
  if (count !== 1) {
    throw new CadError(count > 1
      ? `This model has ${count} separate solids. Join them into one part before exporting.`
      : 'This model has no solid volume. Check the dimensions and Boolean operations.');
  }
  if (!kernel.isSolid(shape)) [shape] = kernel.getSubShapes(shape, 'solid');
  if (!kernel.isValid(shape)) throw new CadError('The model is not a valid solid. Check for touching edges and overlapping features.');
  const volume = kernel.getVolume(shape);
  if (!Number.isFinite(volume) || volume <= 0) throw new CadError('This model has no positive solid volume.');
  return { shape, volume };
}

export function previewSolid(kernel: OcctKernel, shape: ShapeHandle) {
  const { xmin, ymin, zmin, xmax, ymax, zmax } = kernel.getBoundingBox(shape);
  const min: Vec3 = [xmin, ymin, zmin];
  const max: Vec3 = [xmax, ymax, zmax];
  if ([...min, ...max].some((value) => !Number.isFinite(value) || Math.abs(value) > maxLength)) {
    throw new CadError('The model exceeds the supported coordinate range.');
  }
  const span = Math.max(xmax - xmin, ymax - ymin, zmax - zmin);
  const deflection = Math.max(span / 1_200, 0.00001);
  const mesh = kernel.tessellate(shape, { linearDeflection: deflection, angularDeflection: 0.18 });
  if (!mesh.triangleCount || mesh.triangleCount > maxTriangles) {
    throw new CadError('The solid is too complex to preview. Reduce the number of features.');
  }
  const edgeData = kernel.wireframe(shape, { source: 'triangulation', deflection });
  return {
    positions: new Float32Array(mesh.positions),
    normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.indices),
    edgeSegments: edgeSegments(edgeData),
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
        document.setName(definition, part.file.replace(/\.scad$/i, ''));
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

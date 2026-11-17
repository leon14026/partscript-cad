import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { hull, leaves, tangentPolygon, type Disc, type Flat, type Point } from './flat.ts';

type Shape = ShapeHandle | null;

/**
 * A prism of a counter-clockwise polygon. The cookbook in docs/PLAN.md explains
 * why the edges share their vertices.
 */
export function prism(kernel: OcctKernel, points: Point[], height: number): ShapeHandle {
  const vertices = points.map(([x, y]) => kernel.makeVertex(x, y, 0));
  const wire = kernel.makeWire(vertices.map((a, i) => kernel.makeEdge(a, vertices[(i + 1) % vertices.length])));
  return kernel.extrude(kernel.makeFace(wire), 0, 0, height);
}

/** A prism with `sides` equal sides whose corners lie on a circle of radius r, the first on +X, as OpenSCAD draws it. */
export function regularPrism(kernel: OcctKernel, sides: number, radius: number, height: number): ShapeHandle {
  const corners = Array.from({ length: sides }, (_, i): Point => [radius * Math.cos((2 * Math.PI * i) / sides), radius * Math.sin((2 * Math.PI * i) / sides)]);
  return prism(kernel, corners, height);
}

function solidOrEmpty(kernel: OcctKernel, shape: ShapeHandle): Shape {
  return !kernel.isNull(shape) && kernel.subShapeCount(shape, 'solid') > 0 ? shape : null;
}

/**
 * Extrude a 2D shape straight up by `height`. Extruding commutes with Booleans,
 * so each piece of the 2D shape becomes a solid and the 3D Booleans combine them.
 * Null means the shape is empty.
 */
export function extrudeFlat(kernel: OcctKernel, flat: Flat, height: number): Shape {
  const fuse = (shapes: Shape[]): Shape => {
    const found = shapes.filter((shape): shape is ShapeHandle => shape !== null);
    if (!found.length) return null;
    return found.length === 1 ? found[0] : solidOrEmpty(kernel, kernel.fuseAll(found));
  };

  // The same circle often belongs to neighbouring slots. One cylinder per circle keeps the Boolean small.
  const cylinders = new Map<string, ShapeHandle>();
  const cylinder = ({ x, y, r }: Disc) => {
    const key = `${x.toFixed(6)} ${y.toFixed(6)} ${r.toFixed(6)}`;
    let found = cylinders.get(key);
    if (!found) {
      found = kernel.translate(kernel.makeCylinder(r, height), x, y, 0);
      cylinders.set(key, found);
    }
    return found;
  };

  /** The solids to fuse for a shape: a convex outline is a prism and a cylinder for each round corner, and a union is all of its parts together. */
  const pieces = (shape: Flat, seen: Set<ShapeHandle>): ShapeHandle[] => {
    if (shape.kind === 'union') return shape.items.flatMap((item) => pieces(item, seen));
    if (shape.kind !== 'convex') {
      const made = solid(shape);
      return made === null ? [] : [made];
    }
    const round = shape.discs.filter((disc) => disc.r > 0);
    const corners = round.length ? tangentPolygon(shape.discs) : hull(shape.discs.map((disc): Point => [disc.x, disc.y]));
    const parts = corners.length >= 3 ? [prism(kernel, corners, height)] : [];
    for (const disc of round) {
      const made = cylinder(disc);
      if (!seen.has(made)) {
        seen.add(made);
        parts.push(made);
      }
    }
    return parts;
  };

  const solid = (shape: Flat): Shape => {
    switch (shape.kind) {
      case 'convex':
        return fuse(pieces(shape, new Set()));
      case 'polygon': {
        const base = prism(kernel, shape.outer, height);
        if (!shape.holes.length) return base;
        return solidOrEmpty(kernel, kernel.cutAll(base, shape.holes.map((hole) => prism(kernel, hole, height))));
      }
      case 'union':
        return fuse(pieces(shape, new Set()));
      case 'difference': {
        const [base, ...tools] = shape.items.map(solid);
        if (base == null) return null;
        const cuts = tools.filter((tool): tool is ShapeHandle => tool !== null);
        return cuts.length ? solidOrEmpty(kernel, kernel.cutAll(base, cuts)) : base;
      }
      case 'intersection': {
        const [base, ...tools] = shape.items.map(solid);
        let result: Shape = base ?? null;
        for (const tool of tools) {
          if (result == null || tool === null) return null;
          result = solidOrEmpty(kernel, kernel.intersect(result, tool));
        }
        return result;
      }
    }
  };

  const result = solid(flat);
  // Pieces that meet in one plane or one cylinder become one face, so the STEP file stays small.
  return result !== null && leaves(flat) > 1 ? solidOrEmpty(kernel, kernel.unifySameDomain(result)) : result;
}

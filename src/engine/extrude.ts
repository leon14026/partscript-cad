import { JoinType, type OcctKernel, type ShapeHandle } from 'occt-wasm';
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
      case 'offset': {
        // Offset the solid sideways and cut it back to the height. The solid is made taller first so that
        // its caps, which an offset moves too, stay clear of the part that is kept. Arc joins round the
        // corners as offset(r) does, and intersection joins keep them sharp as offset(delta) does.
        const margin = Math.abs(shape.amount) + 1;
        const inner = extrudeFlat(kernel, shape.item, height + 2 * margin);
        if (inner === null) return null;
        // The kernel offsets one solid at a time, so each separate body goes by itself. Offsetting the bodies
        // one by one and fusing the results is the same as offsetting their union.
        const join = shape.round ? JoinType.Arc : JoinType.Intersection;
        const bodies: ShapeHandle[] = [];
        for (const body of kernel.getSubShapes(kernel.translate(inner, 0, 0, -margin), 'solid')) {
          const offset = kernel.offset(body, shape.amount, 1e-6, join);
          // Shrinking a body away leaves a null shape, but the kernel also returns null for some bodies it
          // cannot offset (a slot's rounded end, a D shape). Only a body narrower than twice the shrink is
          // certain to vanish. Dropping any other one would quietly leave geometry out, so it is an error,
          // and the part is meshed instead.
          if (kernel.isNull(offset) && shape.amount < 0) {
            const box = kernel.getBoundingBox(body);
            if (Math.min(box.xmax - box.xmin, box.ymax - box.ymin) < -2 * shape.amount) continue;
            throw new Error('the kernel could not shrink a solid');
          }
          if (kernel.isNull(offset) || !kernel.isValid(offset)) throw new Error('the offset of a solid was not valid');
          // The kernel hands the result back as shells, one for each body left. Close each into a solid.
          for (const shell of kernel.getSubShapes(offset, 'shell')) {
            const closed = kernel.makeSolid(shell);
            bodies.push(kernel.getVolume(closed) < 0 ? kernel.reverseShape(closed) : closed);
          }
        }
        if (!bodies.length) return null;
        const moved = bodies.length === 1 ? bodies[0] : kernel.fuseAll(bodies);
        if (kernel.subShapeCount(moved, 'solid') === 0) return null;
        const { xmin, ymin, xmax, ymax } = kernel.getBoundingBox(moved);
        const slab = kernel.makeBoxFromCorners({ x: xmin - 1, y: ymin - 1, z: 0 }, { x: xmax + 1, y: ymax + 1, z: height });
        return solidOrEmpty(kernel, kernel.intersect(moved, slab));
      }
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

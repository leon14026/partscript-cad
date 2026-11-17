import { JoinType, type OcctKernel, type ShapeHandle } from 'occt-wasm';
import { hull, leaves, tangentPolygon, type Disc, type Flat, type Point } from './flat.ts';

type Shape = ShapeHandle | null;

/**
 * A flat face in the plane z = 0 from a counter-clockwise polygon. The cookbook
 * in docs/PLAN.md explains why the edges share their vertices.
 */
export function polygonFace(kernel: OcctKernel, points: Point[]): ShapeHandle {
  const vertices = points.map(([x, y]) => kernel.makeVertex(x, y, 0));
  return kernel.makeFace(kernel.makeWire(vertices.map((a, i) => kernel.makeEdge(a, vertices[(i + 1) % vertices.length]))));
}

/** A prism of a counter-clockwise polygon. */
export function prism(kernel: OcctKernel, points: Point[], height: number): ShapeHandle {
  return kernel.extrude(polygonFace(kernel, points), 0, 0, height);
}

/** A prism with `sides` equal sides whose corners lie on a circle of radius r, the first on +X, as OpenSCAD draws it. */
export function regularPrism(kernel: OcctKernel, sides: number, radius: number, height: number): ShapeHandle {
  const corners = Array.from({ length: sides }, (_, i): Point => [radius * Math.cos((2 * Math.PI * i) / sides), radius * Math.sin((2 * Math.PI * i) / sides)]);
  return prism(kernel, corners, height);
}

function solidOrEmpty(kernel: OcctKernel, shape: ShapeHandle): Shape {
  return !kernel.isNull(shape) && kernel.subShapeCount(shape, 'solid') > 0 ? shape : null;
}

function faceOrEmpty(kernel: OcctKernel, shape: ShapeHandle): Shape {
  return !kernel.isNull(shape) && kernel.subShapeCount(shape, 'face') > 0 ? shape : null;
}

/**
 * The 2D shape as one face, or several that do not touch, lying in z = 0. The
 * Booleans and the offsets of the shape all happen here, on faces with straight
 * and circular edges. That is far cheaper than doing them on solids, and the
 * kernel offsets a wire reliably where it cannot offset a solid (F25, F28).
 * Null means the shape is empty.
 */
export function flatFace(kernel: OcctKernel, flat: Flat): Shape {
  const merge = (shapes: Shape[]): Shape => {
    const found = shapes.filter((shape): shape is ShapeHandle => shape !== null);
    if (!found.length) return null;
    // Unifying joins faces that touch along an edge into one, so a later offset sees one body.
    return found.length === 1 ? found[0] : faceOrEmpty(kernel, kernel.unifySameDomain(kernel.fuseAll(found)));
  };

  // The same circle often belongs to neighbouring slots. One face per circle keeps the Boolean small.
  const discs = new Map<string, ShapeHandle>();
  const disc = ({ x, y, r }: Disc) => {
    const key = `${x.toFixed(6)} ${y.toFixed(6)} ${r.toFixed(6)}`;
    let found = discs.get(key);
    if (!found) {
      found = kernel.makeFace(kernel.makeWire([kernel.makeCircleEdge({ x, y, z: 0 }, { x: 0, y: 0, z: 1 }, r)]));
      discs.set(key, found);
    }
    return found;
  };

  /** The faces to merge for a shape: a convex outline is a polygon and a disc for each round corner, and a union is all of its parts together. */
  const pieces = (shape: Flat, seen: Set<ShapeHandle>): ShapeHandle[] => {
    if (shape.kind === 'union') return shape.items.flatMap((item) => pieces(item, seen));
    if (shape.kind !== 'convex') {
      const made = region(shape);
      return made === null ? [] : [made];
    }
    const round = shape.discs.filter((item) => item.r > 0);
    const corners = round.length ? tangentPolygon(shape.discs) : hull(shape.discs.map((item): Point => [item.x, item.y]));
    const parts = corners.length >= 3 ? [polygonFace(kernel, corners)] : [];
    for (const item of round) {
      const made = disc(item);
      if (!seen.has(made)) {
        seen.add(made);
        parts.push(made);
      }
    }
    return parts;
  };

  /** The faces of the shape moved outward by `amount` (inward when negative). */
  const offset = (inner: ShapeHandle, amount: number, round: boolean): Shape => {
    // Arc joins round the corners as offset(r) does, and intersection joins keep them sharp as offset(delta) does.
    const join = round ? JoinType.Arc : JoinType.Intersection;
    const rings = (wire: ShapeHandle, distance: number) => kernel.getSubShapes(kernel.offsetWire2D(wire, distance, join), 'wire');
    const results: Shape[] = [];
    for (const face of kernel.getSubShapes(inner, 'face')) {
      // A positive distance moves a wire away from the area it encloses, whichever way it runs. The shape grows when
      // its outline moves out and its holes move in, so a hole's wire goes the other way.
      const rim = kernel.getBoundingBox(kernel.outerWire(face));
      const isRim = (wire: ShapeHandle) => {
        const box = kernel.getBoundingBox(wire);
        return [box.xmin - rim.xmin, box.ymin - rim.ymin, box.xmax - rim.xmax, box.ymax - rim.ymax].every((gap) => Math.abs(gap) < 1e-9);
      };
      const outlines: ShapeHandle[] = [];
      const holes: ShapeHandle[] = [];
      for (const wire of kernel.getSubShapes(face, 'wire')) (isRim(wire) ? outlines : holes).push(wire);
      // A body that shrinks away leaves no wire, and one that narrows to a neck can split in two.
      const body = merge(outlines.flatMap((wire) => rings(wire, amount)).map((ring) => kernel.makeFace(ring)));
      if (body === null) continue;
      const cuts = holes.flatMap((wire) => rings(wire, -amount)).map((ring) => kernel.makeFace(ring));
      results.push(cuts.length ? faceOrEmpty(kernel, kernel.cutAll(body, cuts)) : body);
    }
    return merge(results);
  };

  const region = (shape: Flat): Shape => {
    switch (shape.kind) {
      case 'convex':
        return merge(pieces(shape, new Set()));
      case 'polygon': {
        const base = polygonFace(kernel, shape.outer);
        if (!shape.holes.length) return base;
        return faceOrEmpty(kernel, kernel.cutAll(base, shape.holes.map((hole) => polygonFace(kernel, hole))));
      }
      case 'union':
        return merge(pieces(shape, new Set()));
      case 'offset': {
        const inner = region(shape.item);
        return inner === null ? null : offset(inner, shape.amount, shape.round);
      }
      case 'difference': {
        const [base, ...tools] = shape.items.map(region);
        if (base == null) return null;
        const cuts = tools.filter((tool): tool is ShapeHandle => tool !== null);
        return cuts.length ? faceOrEmpty(kernel, kernel.cutAll(base, cuts)) : base;
      }
      case 'intersection': {
        const [base, ...tools] = shape.items.map(region);
        let result: Shape = base ?? null;
        for (const tool of tools) {
          if (result == null || tool === null) return null;
          result = faceOrEmpty(kernel, kernel.intersect(result, tool));
        }
        return result;
      }
    }
  };

  return region(flat);
}

/**
 * Extrude a 2D shape straight up by `height`. Null means the shape is empty.
 */
export function extrudeFlat(kernel: OcctKernel, flat: Flat, height: number): Shape {
  const face = flatFace(kernel, flat);
  if (face === null) return null;
  const result = solidOrEmpty(kernel, kernel.extrude(face, 0, 0, height));
  // Pieces that meet in one plane or one cylinder become one face, so the STEP file stays small.
  return result !== null && leaves(flat) > 1 ? solidOrEmpty(kernel, kernel.unifySameDomain(result)) : result;
}

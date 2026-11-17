import type { CsgNode, Value } from './csg.ts';

/**
 * The 2D shapes under a linear_extrude, in a form the exact builder can extrude
 * without ever making an arc or circle wire. See docs/PLAN.md, phase 5.
 *
 * Most outlines are the convex hull of some discs: a circle is one disc, a
 * square is four discs of radius 0, a slot is two discs, a rounded rectangle is
 * four. Anything concave is a polygon, and the rest are Booleans of those.
 */
export type Point = [number, number];
/** A circle; r = 0 is a point. */
export interface Disc { x: number; y: number; r: number }
export type Flat =
  | { kind: 'convex'; discs: Disc[] }
  | { kind: 'polygon'; outer: Point[]; holes: Point[][] }
  /** `item` moved outward by `amount` (inward when negative): rounded corners for offset(r), sharp for offset(delta). */
  | { kind: 'offset'; amount: number; round: boolean; item: Flat }
  | { kind: 'union' | 'difference' | 'intersection'; items: Flat[] };

/**
 * The most solids one extrusion may need. A part that needs more stays faceted.
 * Booleans of disjoint shapes stay fast far past this, but a chain of overlapping
 * slots costs about 30 ms a leaf (the crank disk's 135 leaves took 4 s), so this
 * keeps the worst part to a few seconds.
 */
export const maxLeaves = 100;
const maxRing = 1500;
const maxPoints = 30_000;
const near = 1e-9;

class Unsupported extends Error {}

function stop(reason: string): never {
  throw new Unsupported(reason);
}

const nothing: Flat = { kind: 'union', items: [] };

export function isNothing(flat: Flat) {
  return flat.kind === 'union' && flat.items.length === 0;
}

function cross(o: Point, a: Point, b: Point) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function area(ring: Point[]) {
  let sum = 0;
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    sum += p[0] * q[1] - q[0] * p[1];
  });
  return sum / 2;
}

/** The convex hull, counter-clockwise, with no collinear points. Fewer than three points when the input has no area. */
export function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const unique = sorted.filter((p, i) => i === 0 || Math.hypot(p[0] - sorted[i - 1][0], p[1] - sorted[i - 1][1]) > near);
  if (unique.length < 3) return unique;
  const half = (input: Point[]) => {
    const chain: Point[] = [];
    for (const p of input) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= near) chain.pop();
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  const result = [...half(unique), ...half([...unique].reverse())];
  return result.length < 3 || Math.abs(area(result)) < 1e-12 ? [] : result;
}

/**
 * Drop repeated and collinear points and make the winding counter-clockwise.
 * Undefined when nothing with area is left.
 */
function cleanRing(points: Point[]): Point[] | undefined {
  let ring = points.filter((p, i) => {
    const q = points[(i + points.length - 1) % points.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > near;
  });
  for (let changed = true; changed && ring.length >= 3;) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length];
      const b = ring[i];
      const c = ring[(i + 1) % ring.length];
      const ab = [b[0] - a[0], b[1] - a[1]];
      const bc = [c[0] - b[0], c[1] - b[1]];
      const turn = ab[0] * bc[1] - ab[1] * bc[0];
      if (Math.abs(turn) > 1e-9 * Math.hypot(ab[0], ab[1]) * Math.hypot(bc[0], bc[1])) continue;
      if (ab[0] * bc[0] + ab[1] * bc[1] < 0) stop('polygon that doubles back on itself');
      ring = ring.filter((_, k) => k !== i);
      changed = true;
      break;
    }
  }
  if (ring.length < 3) return undefined;
  if (Math.abs(area(ring)) < 1e-12) {
    // A ring with no area is a line, unless it crosses itself and the two halves cancel.
    if (ring.some((p) => Math.abs(cross(ring[0], ring[1], p)) > near * Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]))) stop('polygon that crosses itself');
    return undefined;
  }
  return area(ring) > 0 ? ring : ring.reverse();
}

function distance(a: Point, b: Point, p: Point) {
  return cross(a, b, p) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
}

/** True when two segments share any point, an end included. */
function touch(a: Point, b: Point, c: Point, d: Point) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) - near || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - near) return false;
  if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) - near || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - near) return false;
  const d1 = distance(c, d, a);
  const d2 = distance(c, d, b);
  const d3 = distance(a, b, c);
  const d4 = distance(a, b, d);
  if (((d1 > near && d2 < -near) || (d1 < -near && d2 > near)) && ((d3 > near && d4 < -near) || (d3 < -near && d4 > near))) return true;
  const within = (p: Point, q: Point, r: Point) =>
    Math.min(p[0], q[0]) - near <= r[0] && r[0] <= Math.max(p[0], q[0]) + near
    && Math.min(p[1], q[1]) - near <= r[1] && r[1] <= Math.max(p[1], q[1]) + near;
  return (Math.abs(d1) <= near && within(c, d, a)) || (Math.abs(d2) <= near && within(c, d, b))
    || (Math.abs(d3) <= near && within(a, b, c)) || (Math.abs(d4) <= near && within(a, b, d));
}

function simple(ring: Point[]) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (touch(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** True when any edge of one ring touches any edge of the other. */
function ringsTouch(a: Point[], b: Point[]) {
  return a.some((p, i) => b.some((q, j) => touch(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}

/** True when the point is inside the ring and not on its outline. */
function strictlyInside(ring: Point[], p: Point) {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (touch(a, b, p, p)) return false;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
  }
  return inside;
}

function convexRing(ring: Point[]) {
  return ring.every((p, i) => cross(p, ring[(i + 1) % ring.length], ring[(i + 2) % ring.length]) > 0);
}

/** Cut a convex ring by a half-plane: keep the points where value(p) <= 0. */
function clip(ring: Point[], value: (p: Point) => number) {
  const out: Point[] = [];
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const va = value(a);
    const vb = value(b);
    if (va <= 0) out.push(a);
    if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) {
      const t = va / (va - vb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  });
  return out;
}

/** Move every edge of a convex counter-clockwise polygon outward by d, corners sharp. A negative d shrinks it; an empty list means it vanished. */
function offsetConvex(poly: Point[], d: number): Point[] {
  const n = poly.length;
  const edges = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return { p, direction: [(q[0] - p[0]) / length, (q[1] - p[1]) / length], normal: [(q[1] - p[1]) / length, -(q[0] - p[0]) / length] };
  });
  if (d > 0) {
    // Neighbouring edges, each moved out by d, meet at the new corner.
    return poly.map((_, i) => {
      const a = edges[(i + n - 1) % n];
      const b = edges[i];
      const pa = [a.p[0] + a.normal[0] * d, a.p[1] + a.normal[1] * d];
      const pb = [b.p[0] + b.normal[0] * d, b.p[1] + b.normal[1] * d];
      const turn = a.direction[0] * b.direction[1] - a.direction[1] * b.direction[0];
      const t = ((pb[0] - pa[0]) * b.direction[1] - (pb[1] - pa[1]) * b.direction[0]) / turn;
      return [pa[0] + a.direction[0] * t, pa[1] + a.direction[1] * t] as Point;
    });
  }
  // Shrinking can make an edge disappear, so cut the polygon by each moved edge instead.
  let ring = poly;
  for (const { p, normal } of edges) {
    if (ring.length < 3) break;
    ring = clip(ring, (q) => normal[0] * (q[0] - p[0]) + normal[1] * (q[1] - p[1]) - d);
  }
  return hull(ring);
}

function sameDisc(a: Disc, b: Disc) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= near && Math.abs(a.r - b.r) <= near;
}

/** A convex outline from discs. Collapses a polygon of points to its hull, and returns nothing for a shape with no area. */
function convex(discs: Disc[]): Flat {
  const found = discs.filter((disc, i) => disc.r >= 0 && discs.findIndex((other) => sameDisc(other, disc)) === i);
  if (!found.length) return nothing;
  if (found.every((disc) => disc.r === 0)) {
    const corners = hull(found.map((disc): Point => [disc.x, disc.y]));
    return corners.length < 3 ? nothing : { kind: 'convex', discs: corners.map(([x, y]) => ({ x, y, r: 0 })) };
  }
  return { kind: 'convex', discs: found };
}

/**
 * The points where a straight line touches two discs on the same side, for every
 * pair, as a convex polygon. With a cylinder at each disc it fills the hull of
 * the discs exactly (F16). Empty when no pair of discs gives a tangent.
 */
export function tangentPolygon(discs: Disc[]): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < discs.length; i++) {
    for (let j = i + 1; j < discs.length; j++) {
      const a = discs[i];
      const b = discs[j];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d <= Math.abs(a.r - b.r) + near) continue; // one disc holds the other
      const u = [(b.x - a.x) / d, (b.y - a.y) / d];
      const n = [-u[1], u[0]];
      const c = (a.r - b.r) / d;
      const s = Math.sqrt(Math.max(0, 1 - c * c));
      for (const side of [1, -1]) {
        const t = [c * u[0] + side * s * n[0], c * u[1] + side * s * n[1]];
        points.push([a.x + a.r * t[0], a.y + a.r * t[1]], [b.x + b.r * t[0], b.y + b.r * t[1]]);
      }
    }
  }
  return hull(points);
}

/** How many solids it takes to make a shape. */
export function leaves(flat: Flat): number {
  if (flat.kind === 'convex') return 1 + flat.discs.filter((disc) => disc.r > 0).length;
  if (flat.kind === 'polygon') return 1 + flat.holes.length;
  if (flat.kind === 'offset') return 2 + leaves(flat.item);
  return flat.items.reduce((sum, item) => sum + leaves(item), 0);
}

interface Context {
  points: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pair(value: Value | undefined): Point | undefined {
  return Array.isArray(value) && value.length >= 2 && isNumber(value[0]) && isNumber(value[1]) ? [value[0], value[1]] : undefined;
}

function regular(sides: number, radius: number): Point[] {
  return Array.from({ length: sides }, (_, i): Point => [radius * Math.cos((2 * Math.PI * i) / sides), radius * Math.sin((2 * Math.PI * i) / sides)]);
}

function polygonOf(points: Point[], context: Context): Flat {
  context.points += points.length;
  if (context.points > maxPoints) stop('polygon with many points');
  const ring = cleanRing(points);
  if (!ring) return nothing;
  if (convexRing(ring)) return convex(ring.map(([x, y]) => ({ x, y, r: 0 })));
  if (ring.length > maxRing) stop('polygon with many points');
  if (!simple(ring)) stop('polygon that crosses itself');
  return { kind: 'polygon', outer: ring, holes: [] };
}

function readPolygon(node: CsgNode, context: Context): Flat {
  const points = node.named.get('points');
  if (!Array.isArray(points)) stop('polygon');
  const all = (points as Value[]).map((value) => pair(value));
  if (all.some((point) => point === undefined)) stop('polygon');
  const corners = all as Point[];
  const paths = node.named.get('paths');
  const lists = Array.isArray(paths) && paths.length
    ? (paths as Value[]).map((path) => (Array.isArray(path) ? path : stop('polygon')))
    : [corners.map((_, i) => i)];
  const rings = lists.map((list) => (list as Value[]).map((index) => {
    const point = isNumber(index) ? corners[index] : undefined;
    return point ?? stop('polygon');
  }));
  if (rings.length === 1) return polygonOf(rings[0], context);

  // Several outlines are an outer one with holes in it. Anything else is left to OpenSCAD.
  context.points += corners.length;
  if (context.points > maxPoints) stop('polygon with many points');
  const clean = rings.map((ring) => cleanRing(ring));
  if (clean.some((ring) => !ring || ring.length > maxRing)) stop('polygon with several outlines');
  const found = clean as Point[][];
  if (found.some((ring) => !simple(ring))) stop('polygon that crosses itself');
  const outer = found.reduce((best, ring) => (area(ring) > area(best) ? ring : best));
  const holes = found.filter((ring) => ring !== outer);
  const apart = holes.every((hole, i) => hole.every((p) => strictlyInside(outer, p)) && !ringsTouch(hole, outer)
    && holes.every((other, j) => j <= i || (!ringsTouch(hole, other)
      && hole.every((p) => !strictlyInside(other, p)) && other.every((p) => !strictlyInside(hole, p)))));
  if (!apart) stop('polygon with several outlines');
  return { kind: 'polygon', outer, holes };
}

interface Move {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  scale: number;
  mirror: boolean;
}

/** Read a multmatrix of a 2D shape: a rotation or mirror, a uniform scale, and a move in the plane. */
function readMove(input: Value | undefined): Move {
  const valid = Array.isArray(input) && input.length === 4
    && input.every((row) => Array.isArray(row) && row.length === 4 && row.every(isNumber));
  if (!valid) stop('multmatrix');
  const m = input as number[][];
  const flatOnly = m[0][2] === 0 && m[1][2] === 0 && m[2][0] === 0 && m[2][1] === 0
    && m[3][0] === 0 && m[3][1] === 0 && m[3][2] === 0 && m[3][3] === 1;
  if (!flatOnly) stop('multmatrix');
  const [a, b, c, d] = [m[0][0], m[0][1], m[1][0], m[1][1]];
  const first = Math.hypot(a, c);
  const second = Math.hypot(b, d);
  if (first <= 0 || Math.abs(first - second) > 4e-6 * Math.max(first, second) || Math.abs(a * b + c * d) > 4e-6 * first * second) {
    stop(b === 0 && c === 0 ? 'scale' : 'multmatrix');
  }
  const mirror = a * d - b * c < 0;
  const scale = Math.abs(first - 1) < 2e-6 ? 1 : first;
  // Restore a right angle between the axes, as the 3D builder does for six-digit matrices.
  const ux = a / first;
  const uy = c / first;
  const [vx, vy] = mirror ? [uy, -ux] : [-uy, ux];
  return { a: scale * ux, b: scale * vx, c: scale * uy, d: scale * vy, tx: m[0][3], ty: m[1][3], scale, mirror };
}

function place(flat: Flat, move: Move): Flat {
  const at = ([x, y]: Point): Point => [move.a * x + move.b * y + move.tx, move.c * x + move.d * y + move.ty];
  const ring = (points: Point[]) => {
    const moved = points.map(at);
    return move.mirror ? moved.reverse() : moved;
  };
  switch (flat.kind) {
    case 'convex':
      return { kind: 'convex', discs: flat.discs.map(({ x, y, r }) => ({ x: at([x, y])[0], y: at([x, y])[1], r: r * move.scale })) };
    case 'polygon':
      return { kind: 'polygon', outer: ring(flat.outer), holes: flat.holes.map(ring) };
    case 'offset':
      return { kind: 'offset', amount: flat.amount * move.scale, round: flat.round, item: place(flat.item, move) };
    default:
      return { kind: flat.kind, items: flat.items.map((item) => place(item, move)) };
  }
}

function union(items: Flat[]): Flat {
  const found = items.filter((item) => !isNothing(item));
  if (!found.length) return nothing;
  return found.length === 1 ? found[0] : { kind: 'union', items: found };
}

/** The discs of a convex shape, or of a union of convex shapes, which share one hull. */
function discsOf(flat: Flat): Disc[] | undefined {
  if (flat.kind === 'convex') return flat.discs;
  if (flat.kind !== 'union') return undefined;
  const lists = flat.items.map(discsOf);
  return lists.every((list) => list !== undefined) ? lists.flat() as Disc[] : undefined;
}

function evaluate(node: CsgNode, context: Context): Flat {
  const { operation, named, children } = node;
  const all = () => children.map((child) => evaluate(child, context));
  switch (operation) {
    case 'circle': {
      const r = named.get('r');
      if (!isNumber(r) || r <= 0) return nothing;
      const fn = named.get('$fn') ?? 0;
      if (!isNumber(fn) || fn < 0) stop('circle');
      if (fn === 0) return { kind: 'convex', discs: [{ x: 0, y: 0, r }] };
      return polygonOf(regular(Math.max(3, Math.trunc(fn as number)), r), context);
    }
    case 'square': {
      const size = pair(named.get('size'));
      if (!size) stop('square');
      const [w, h] = size as Point;
      if (w <= 0 || h <= 0) return nothing;
      const [x0, y0] = named.get('center') === true ? [-w / 2, -h / 2] : [0, 0];
      return polygonOf([[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], context);
    }
    case 'polygon':
      return readPolygon(node, context);
    case 'multmatrix': {
      const move = readMove(node.positional[0]);
      const inside = union(all());
      return isNothing(inside) ? inside : place(inside, move);
    }
    case 'group':
    case 'union':
    case 'color':
    case 'render':
      return union(all());
    case 'difference': {
      const [base, ...tools] = all();
      if (base === undefined || isNothing(base)) return nothing;
      const cuts = tools.filter((tool) => !isNothing(tool));
      return cuts.length ? { kind: 'difference', items: [base, ...cuts] } : base;
    }
    case 'intersection': {
      const items = all();
      if (!items.length || items.some(isNothing)) return nothing;
      return items.length === 1 ? items[0] : { kind: 'intersection', items };
    }
    case 'hull': {
      const items = all().filter((item) => !isNothing(item));
      if (!items.length) return nothing;
      const lists = items.map(discsOf);
      if (lists.some((list) => list === undefined)) stop('hull of a shape that is not convex');
      return convex((lists as Disc[][]).flat());
    }
    case 'offset': {
      const inside = union(all());
      if (isNothing(inside)) return inside;
      const sharp = named.get('delta');
      const round = named.get('r');
      const amount = sharp !== undefined ? sharp : round;
      if (!isNumber(amount)) stop('offset');
      if (sharp !== undefined && named.get('chamfer') === true) stop('offset with chamfer');
      if (amount === 0) return inside;
      const grow = amount as number;
      // Anything but a convex outline is offset as a solid, see extrude.ts.
      const general: Flat = { kind: 'offset', amount: grow, round: sharp === undefined, item: inside };
      if (inside.kind !== 'convex') return general;
      const { discs } = inside as Extract<Flat, { kind: 'convex' }>;
      if (discs.length === 1 && discs[0].r > 0) {
        const r = discs[0].r + grow;
        return r > 0 ? { kind: 'convex', discs: [{ ...discs[0], r }] } : nothing;
      }
      const corners = discs.every((disc) => disc.r === 0);
      if (round !== undefined && sharp === undefined && grow > 0) {
        return convex(discs.map((disc) => ({ ...disc, r: disc.r + grow })));
      }
      if (corners) {
        const moved = offsetConvex(hull(discs.map((disc): Point => [disc.x, disc.y])), grow);
        return moved.length < 3 ? nothing : convex(moved.map(([x, y]) => ({ x, y, r: 0 })));
      }
      return general;
    }
    default:
      return stop(operation);
  }
}

export interface Extrusion {
  height: number;
  center: boolean;
  flat: Flat;
}

/**
 * Read a linear_extrude node. Returns its height, centring and 2D shape, or
 * the reason it has to be meshed instead. unsupported() in csg.ts and the exact
 * builder both call this, so they always agree.
 */
export function extrusion(node: CsgNode): Extrusion | { reason: string } {
  try {
    const { named } = node;
    const height = named.get('height');
    if (!isNumber(height) || height <= 0) stop('linear_extrude with no positive height');
    if ((named.get('twist') ?? 0) !== 0) stop('linear_extrude with twist');
    const factor = named.get('scale') ?? 1;
    const untouched = factor === 1 || (Array.isArray(factor) && factor.length === 2 && factor.every((value) => value === 1));
    if (!untouched) stop('linear_extrude with scale');
    const flat = union(node.children.map((child) => evaluate(child, { points: 0 })));
    if (leaves(flat) > maxLeaves) stop(`linear_extrude with more than ${maxLeaves} shapes`);
    return { height: height as number, center: named.get('center') === true, flat };
  } catch (error) {
    if (error instanceof Unsupported) return { reason: error.message };
    throw error;
  }
}

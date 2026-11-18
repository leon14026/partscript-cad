import { extrusion } from './flat.ts';
import { CadError } from './protocol.ts';

export type Value = number | boolean | string | null | Value[];

export interface CsgNode {
  /** The name as OpenSCAD prints it: cube, multmatrix, linear_extrude, hull, ... */
  operation: string;
  named: Map<string, Value>;
  positional: Value[];
  children: CsgNode[];
  /** Where the node sits in the dump: its first character (a modifier such as # included) to just past its closing brace or semicolon. */
  start: number;
  end: number;
}

const nodeLimit = 200_000;
const depthLimit = 200;
const valueDepthLimit = 12;
const charLimit = 16 * 1024 * 1024;

/** A `render` node with a convexity from this number up marks the shapes of an inline part. See part() in assembly.ts. */
export const partTagBase = 900_000;

const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"' };

class Reader {
  #input: string;
  #offset = 0;
  #count = 0;

  constructor(input: string) {
    this.#input = input;
  }

  #match(pattern: RegExp) {
    pattern.lastIndex = this.#offset;
    const match = pattern.exec(this.#input);
    if (match) this.#offset = pattern.lastIndex;
    return match?.[0];
  }

  #space() {
    this.#match(/(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/y);
  }

  #eat(literal: string) {
    this.#space();
    if (!this.#input.startsWith(literal, this.#offset)) return false;
    this.#offset += literal.length;
    return true;
  }

  #expect(literal: string) {
    if (!this.#eat(literal)) this.#unexpected();
  }

  #unexpected(): never {
    throw new CadError('The model contains an unexpected value in the OpenSCAD geometry output.');
  }

  #value(depth = 0): Value {
    if (depth > valueDepthLimit) this.#unexpected();
    if (this.#eat('[')) {
      const values: Value[] = [];
      if (this.#eat(']')) return values;
      do {
        values.push(this.#value(depth + 1));
      } while (this.#eat(','));
      this.#expect(']');
      return values;
    }
    if (this.#match(/true\b/y)) return true;
    if (this.#match(/false\b/y)) return false;
    if (this.#match(/undef\b/y)) return null;
    const text = this.#match(/"(?:\\[\s\S]|[^"\\])*"/y);
    if (text !== undefined) return text.slice(1, -1).replace(/\\([\s\S])/g, (_, c: string) => escapes[c] ?? c);
    const word = this.#match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+-]?(?:inf|nan)\b/y);
    if (word === undefined) {
      throw new CadError('A shape or transform uses an undefined or non-finite value. Check the dimensions in your code.');
    }
    return Number(word.replace(/^([+-]?)inf$/, '$1Infinity'));
  }

  nodes(depth = 0): CsgNode[] {
    const nodes: CsgNode[] = [];
    while (true) {
      this.#space();
      const next = this.#input[this.#offset];
      if (depth ? next === '}' : next === undefined) return nodes;
      if (next === undefined) this.#unexpected();
      if (this.#eat(';')) continue;
      const node = this.#node(depth);
      if (node) nodes.push(node);
    }
  }

  /** Returns undefined for a % background node: OpenSCAD leaves it out of the result. */
  #node(depth: number): CsgNode | undefined {
    if (depth > depthLimit || ++this.#count > nodeLimit) {
      throw new CadError('The model exceeds the size limit. Use fewer repeated shapes or nested operations.');
    }
    this.#space();
    const start = this.#offset;
    let background = false;
    // Highlighted (#) shapes still contribute to the solid. Background (%) shapes do not.
    while (true) {
      if (this.#eat('%')) background = true;
      else if (!this.#eat('#') && !this.#eat('!') && !this.#eat('*')) break;
    }
    this.#space();
    const operation = this.#match(/[A-Za-z_][A-Za-z_\d]*/y);
    if (!operation) this.#unexpected();

    this.#expect('(');
    const named = new Map<string, Value>();
    const positional: Value[] = [];
    if (!this.#eat(')')) {
      do {
        this.#space();
        const prefix = this.#match(/\$?[A-Za-z_][A-Za-z_\d]*(?=\s*=[^=])/y);
        if (prefix) {
          if (named.has(prefix)) this.#unexpected();
          this.#expect('=');
          named.set(prefix, this.#value());
        } else {
          positional.push(this.#value());
        }
      } while (this.#eat(','));
      this.#expect(')');
    }

    let children: CsgNode[] = [];
    if (this.#eat('{')) {
      children = this.nodes(depth + 1);
      this.#expect('}');
    } else {
      this.#expect(';');
    }
    return background ? undefined : { operation, named, positional, children, start, end: this.#offset };
  }
}

export function parseCsg(csg: string): CsgNode[] {
  if (csg.length > charLimit) throw new CadError('The evaluated model is too large. Reduce the number of generated shapes.');
  return new Reader(csg).nodes();
}

const solids = new Set(['cube', 'sphere', 'cylinder']);
const flat = new Set(['circle', 'square', 'polygon', 'text']);
const drawing = new Set([...solids, ...flat, 'polyhedron', 'import', 'surface']);
// The exact builder in solid.ts handles these. color and render pass their children through.
const exact = new Set([...solids, 'linear_extrude', 'multmatrix', 'group', 'union', 'difference', 'intersection', 'color', 'render']);

/** The tag number of an inline part's render node, or undefined for any other node. */
export function nodeTag(node: CsgNode): number | undefined {
  if (node.operation !== 'render') return undefined;
  const convexity = node.named.get('convexity');
  return typeof convexity === 'number' && convexity >= partTagBase ? convexity : undefined;
}

/**
 * True when the tree draws at least one shape. With skipParts, the shapes inside
 * inline parts are not counted, which finds shapes drawn outside every part.
 */
export function hasShapes(nodes: CsgNode[], skipParts = false): boolean {
  return nodes.some((node) => {
    if (skipParts && nodeTag(node) !== undefined) return false;
    return drawing.has(node.operation) || hasShapes(node.children, skipParts);
  });
}

/**
 * Check a multmatrix argument. Returns 'invalid' when it is not a 4x4 matrix of
 * numbers, 'scaled' when it is not a rotation plus translation (a mirror is fine),
 * or undefined for a rigid transform.
 */
export function rigidProblem(input: unknown): 'invalid' | 'scaled' | undefined {
  const valid = Array.isArray(input) && input.length === 4 && input.every((row) =>
    Array.isArray(row) && row.length === 4 && row.every((value) => typeof value === 'number' && Number.isFinite(value)));
  if (!valid) return 'invalid';
  const [x, y, z, w] = input as number[][];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = [x[0], y[0], z[0]];
  const b = [x[1], y[1], z[1]];
  const c = [x[2], y[2], z[2]];
  const tolerance = 0.000004;
  const residuals = [dot(a, a) - 1, dot(b, b) - 1, dot(c, c) - 1, dot(a, b), dot(a, c), dot(b, c)];
  const rigid = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 1 && residuals.every((r) => Math.abs(r) <= tolerance);
  return rigid ? undefined : 'scaled';
}

function isDiagonal(input: unknown) {
  const rows = input as number[][];
  return [0, 1, 2].every((i) => [0, 1, 2].every((j) => i === j || rows[i][j] === 0));
}

/**
 * What a multmatrix does to a shape: 'rigid' (rotation, mirror and move), 'uniform'
 * (those times one scale factor), 'axes' (a different positive factor on each axis,
 * no shear), 'invalid', or 'other' for anything the exact builder cannot make.
 */
export type MoveKind =
  | { kind: 'rigid' | 'invalid' | 'other' }
  | { kind: 'uniform'; factor: number }
  | { kind: 'axes'; factors: [number, number, number] };

export function moveKind(input: unknown): MoveKind {
  const problem = rigidProblem(input);
  if (problem === 'invalid') return { kind: 'invalid' };
  if (!problem) return { kind: 'rigid' };
  const [x, y, z, w] = input as number[][];
  if (w[0] !== 0 || w[1] !== 0 || w[2] !== 0 || w[3] !== 1) return { kind: 'other' };
  if (isDiagonal(input)) {
    const factors: [number, number, number] = [x[0], y[1], z[2]];
    const same = factors.every((factor) => Math.abs(factor - factors[0]) <= 4e-6 * Math.abs(factors[0]));
    if (!same && factors.every((factor) => factor > 0)) return { kind: 'axes', factors };
  }
  // A turned, mirrored or scaled shape whose three axes stay at right angles and keep one length.
  const axes = [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
  const lengths = axes.map((axis) => Math.hypot(axis[0], axis[1], axis[2]));
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const square = lengths.every((length) => length > 0 && Math.abs(length - lengths[0]) <= 4e-6 * lengths[0])
    && [dot(axes[0], axes[1]), dot(axes[0], axes[2]), dot(axes[1], axes[2])].every((value) => Math.abs(value) <= 4e-6 * lengths[0] ** 2);
  return square ? { kind: 'uniform', factor: lengths[0] } : { kind: 'other' };
}

/**
 * True when the exact builder uses something an OpenSCAD mesh can disagree with:
 * an extrusion, a prism from $fn, or a scaled shape. build.ts checks such a part
 * against OpenSCAD's own mesh. A part of only boxes, cylinders and spheres needs no check.
 */
export function needsCheck(nodes: CsgNode[]): boolean {
  return nodes.some((node) => {
    if (node.operation === 'linear_extrude') return true;
    if (node.operation === 'cylinder' && (node.named.get('$fn') ?? 0) !== 0) return true;
    if (node.operation === 'multmatrix' && moveKind(node.positional[0]).kind !== 'rigid') return true;
    return needsCheck(node.children);
  });
}

/**
 * The side count of every shape that the exact builder makes as a flat-sided prism
 * because `$fn` is above zero: a cylinder with equal radii, and a circle inside an
 * extrusion. These are polygons in STEP, so a hole made from one is not round.
 * Only meaningful for a tree that unsupported() accepts. The sides are counted as
 * solid.ts and flat.ts build them: at least 3, a fraction dropped.
 */
export function flatRounds(nodes: CsgNode[]): number[] {
  const sides: number[] = [];
  const walk = (list: CsgNode[]) => {
    for (const node of list) {
      const fn = node.named.get('$fn');
      if (typeof fn === 'number' && fn > 0) {
        const [bottom, top, radius] = [node.named.get('r1'), node.named.get('r2'), node.named.get('r')];
        const prism = node.operation === 'cylinder' && typeof bottom === 'number' && bottom === top && bottom > 0;
        const disc = node.operation === 'circle' && typeof radius === 'number' && radius > 0;
        if (prism || disc) sides.push(Math.max(3, Math.trunc(fn)));
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return sides;
}

/**
 * The first operation in the tree that the exact builder (solid.ts) cannot make,
 * or undefined when every node is a box, cylinder, sphere, extrusion, scaled or
 * rigid move or Boolean. Such a part is meshed by OpenSCAD instead. The name
 * says why, for example "hull". An extrusion is exact when flat.ts can describe
 * its whole 2D shape.
 */
export function unsupported(nodes: CsgNode[]): string | undefined {
  for (const node of nodes) {
    const { operation } = node;
    if (!exact.has(operation)) return operation;
    if (operation === 'linear_extrude') {
      const found = extrusion(node);
      if ('reason' in found) return found.reason;
      continue;
    }
    if (operation === 'sphere' && (node.named.get('$fn') ?? 0) !== 0) return 'sphere with $fn';
    if (operation === 'cylinder' && (node.named.get('$fn') ?? 0) !== 0) {
      // $fn above zero asks for visible facets. Equal radii make a regular prism. A cone cannot be exact.
      const [bottom, top] = [node.named.get('r1'), node.named.get('r2')];
      if (typeof bottom !== 'number' || bottom !== top || bottom <= 0) return 'cylinder with $fn';
    }
    if (operation === 'multmatrix') {
      const move = moveKind(node.positional[0]);
      if (move.kind === 'invalid') return operation;
      if (move.kind === 'other') return isDiagonal(node.positional[0]) ? 'scale' : operation;
    }
    const inner = unsupported(node.children);
    if (inner) return inner;
  }
  return undefined;
}

export interface TaggedPart {
  tag: number;
  node: CsgNode;
  /** The first enclosing operation other than group, union and color, such as multmatrix. A part cannot sit inside one. */
  wrapper?: string;
}

const transparent = new Set(['group', 'union', 'color']);

/** The inline parts in the tree, in document order. A part is not searched for parts of its own. */
export function taggedParts(nodes: CsgNode[], wrapper?: string): TaggedPart[] {
  const found: TaggedPart[] = [];
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (tag !== undefined) found.push({ tag, node, wrapper });
    else found.push(...taggedParts(node.children, wrapper ?? (transparent.has(node.operation) ? undefined : node.operation)));
  }
  return found;
}

/** The dump text of a node's children, from the first to the last. Empty when there are none. */
export function childrenText(csg: string, node: CsgNode): string {
  const first = node.children[0];
  const last = node.children.at(-1);
  return first && last ? csg.slice(first.start, last.end) : '';
}

/** The red, green and blue of the first color() in the tree, or undefined. */
export function firstColor(nodes: CsgNode[]): [number, number, number] | undefined {
  for (const node of nodes) {
    if (node.operation === 'color') {
      const [value] = node.positional;
      if (Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every((c) => typeof c === 'number')) {
        return value.slice(0, 3) as [number, number, number];
      }
    }
    const inner = firstColor(node.children);
    if (inner) return inner;
  }
  return undefined;
}

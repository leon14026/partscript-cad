import { CadError } from './protocol.ts';

const operations = ['cube', 'sphere', 'cylinder', 'multmatrix', 'group', 'union', 'difference', 'intersection'] as const;
type Operation = typeof operations[number];
type Value = number | boolean | Value[];

export interface CsgNode {
  operation: Operation;
  named: Map<string, Value>;
  positional: Value[];
  children: CsgNode[];
}

const nodeLimit = 2_000;
const depthLimit = 96;
const charLimit = 2 * 1024 * 1024;

function isSupported(operation: string): operation is Operation {
  return (operations as readonly string[]).includes(operation);
}

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
    if (depth > 4) this.#unexpected();
    if (this.#eat('[')) {
      const values: Value[] = [];
      if (this.#eat(']')) return values;
      do {
        if (values.length === 16) this.#unexpected();
        values.push(this.#value(depth + 1));
      } while (this.#eat(','));
      this.#expect(']');
      return values;
    }
    if (this.#match(/true\b/y)) return true;
    if (this.#match(/false\b/y)) return false;
    const number = Number(this.#match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y));
    if (!Number.isFinite(number)) {
      throw new CadError('A shape or transform uses an undefined or non-finite value. Check the dimensions in your code.');
    }
    return number;
  }

  nodes(depth = 0): CsgNode[] {
    const nodes: CsgNode[] = [];
    while (true) {
      this.#space();
      const next = this.#input[this.#offset];
      if (depth ? next === '}' : next === undefined) return nodes;
      if (next === undefined) this.#unexpected();
      if (this.#eat(';')) continue;
      nodes.push(this.#node(depth));
    }
  }

  #node(depth: number): CsgNode {
    if (depth > depthLimit || ++this.#count > nodeLimit) {
      throw new CadError('The model exceeds the size limit. Use fewer repeated shapes or nested operations.');
    }
    if (this.#eat('%')) throw new CadError('Remove the % background modifier before building the solid.');
    this.#eat('#'); // Highlighted shapes still contribute to the OpenSCAD solid.
    this.#space();
    const operation = this.#match(/[A-Za-z_][A-Za-z_\d]*/y);
    if (!operation) this.#unexpected();
    if (!isSupported(operation)) throw new CadError(`The operation ${operation}() is unavailable in this version.`);

    this.#expect('(');
    const named = new Map<string, Value>();
    const positional: Value[] = [];
    if (!this.#eat(')')) {
      do {
        this.#space();
        const prefix = this.#match(/\$?[A-Za-z_][A-Za-z_\d]*(?=\s*=)/y);
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

    if (this.#eat('{')) {
      const children = this.nodes(depth + 1);
      this.#expect('}');
      return { operation, named, positional, children };
    }
    this.#expect(';');
    return { operation, named, positional, children: [] };
  }
}

export function parseCsg(csg: string): CsgNode[] {
  if (csg.length > charLimit) throw new CadError('The evaluated model is too large. Reduce the number of generated shapes.');
  return new Reader(csg).nodes();
}

/** True when the tree places at least one shape. */
export function hasShapes(nodes: CsgNode[]): boolean {
  return nodes.some((node) => node.operation === 'cube' || node.operation === 'sphere' || node.operation === 'cylinder' || hasShapes(node.children));
}

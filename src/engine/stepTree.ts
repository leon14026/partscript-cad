import type { LabelTag, OcctKernel, ShapeHandle, XCAFDocument } from 'occt-wasm';
import { CadError, type StepComponent, type StepStructure } from './protocol.ts';

/**
 * Reading what a STEP file holds beyond its solids: the product structure, with each component's name,
 * colour and place. The kernel reads it through an XCAF document.
 *
 * Measured on 18 November 2026 (F37 to F39 in docs/PLAN.md): the solids come out in the same order
 * whether they are read with importStep, from the XCAF root or depth first through the components, and
 * they are in the file's own frame; a component's geometry is its definition's shape placed by the
 * locations on the way down, which is what `placed` does (the shape the kernel offers for a nested
 * component carries only its own location, not its parent's).
 */

/** part() asked for a component or body the file does not have. build.ts adds the part's name and the file of the part() call. */
export class SelectionError extends CadError {}

type Matrix = number[];
const identity: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** Components the asset panel lists. More are still reachable by name in part(). */
export const maxListed = 500;

interface Node {
  path: string;
  name: string;
  depth: number;
  /** The label that owns the geometry and the children. */
  definition: LabelTag;
  /** From the file's frame to this component. */
  matrix: Matrix;
  color?: [number, number, number];
  /** True when nothing is below it, so its solids are not counted in another component. */
  leaf: boolean;
}

/** A name a person gave, as opposed to the placeholders a CAD program writes when a component has none. */
const given = (name: string) => name.trim() !== '' && !name.startsWith('=>[');

function* visit(kernel: OcctKernel, doc: XCAFDocument, label: LabelTag, parent: Matrix, parentPath: string, depth: number, inherited: Node['color'], taken: Map<string, number>): Generator<Node> {
  const info = doc.getLabelInfo(label);
  const referred = doc.getReferredLabel(label);
  const definition = referred ?? label;
  const definitionInfo = referred != null ? doc.getLabelInfo(referred) : info;
  let name = given(info.name) ? info.name : given(definitionInfo.name) ? definitionInfo.name : 'component';
  name = name.replace(/\//g, '-').trim();
  const count = (taken.get(name) ?? 0) + 1;
  taken.set(name, count);
  if (count > 1) name = `${name} ${count}`;
  const path = parentPath ? `${parentPath}/${name}` : name;
  const matrix = kernel.composeTransform(parent, doc.getLocation(label));
  const color = info.hasColor ? info.color : definitionInfo.hasColor ? definitionInfo.color : inherited;
  const children = doc.getChildren(definition);
  yield { path, name, depth, definition, matrix, color, leaf: children.length === 0 };
  const below = new Map<string, number>();
  for (const child of children) yield* visit(kernel, doc, child, matrix, path, depth + 1, color, below);
}

/**
 * Every component below the top of the file, depth first. A file with one root lists the root's children.
 * A file with several roots lists the roots. A file with one root and nothing below it has no components.
 * The caller holds a checkpoint: each label read leaves a handle behind.
 */
function* walk(kernel: OcctKernel, doc: XCAFDocument): Generator<Node> {
  const roots = doc.getRoots();
  const taken = new Map<string, number>();
  if (roots.length === 1) {
    const root = roots[0];
    const info = doc.getLabelInfo(root);
    const matrix = kernel.composeTransform(identity, doc.getLocation(root));
    for (const child of doc.getChildren(doc.getReferredLabel(root) ?? root)) {
      yield* visit(kernel, doc, child, matrix, '', 0, info.hasColor ? info.color : undefined, taken);
    }
    return;
  }
  for (const root of roots) yield* visit(kernel, doc, root, identity, '', 0, undefined, taken);
}

const isIdentity = (matrix: Matrix) => matrix.every((value, i) => Math.abs(value - identity[i]) < 1e-12);

/** The component's geometry in the file's frame, or undefined when it has none. */
function placed(kernel: OcctKernel, doc: XCAFDocument, node: Node): ShapeHandle | undefined {
  const shape = doc.getLabelInfo(node.definition).shapeHandle;
  if (!shape) return undefined;
  return isIdentity(node.matrix) ? shape : kernel.located(shape, node.matrix);
}

/** Every solid body of the file, in the order that `body` counts them. The caller holds a checkpoint. */
export function fileSolids(kernel: OcctKernel, doc: XCAFDocument): ShapeHandle[] {
  return doc.getRoots().flatMap((root) => {
    const shape = doc.getLabelInfo(root).shapeHandle;
    return shape ? kernel.getSubShapes(shape, 'solid') : [];
  });
}

const solidsOf = (kernel: OcctKernel, shape: ShapeHandle | undefined) => (shape ? kernel.getSubShapes(shape, 'solid') : []);

/** The list of components, with each one's bodies, box and colour. Leaves no handles behind. */
export function readStructure(kernel: OcctKernel, doc: XCAFDocument): StepStructure {
  const mark = kernel.checkpoint();
  try {
    const components: StepComponent[] = [];
    let unlisted = 0;
    let seen = 0;
    for (const node of walk(kernel, doc)) {
      const shape = placed(kernel, doc, node);
      const count = solidsOf(kernel, shape).length;
      const firstBody = seen + 1;
      if (node.leaf) seen += count;
      if (components.length >= maxListed) {
        unlisted++;
        continue;
      }
      let bounds: StepComponent['bounds'] = { min: [0, 0, 0], max: [0, 0, 0] };
      if (shape && count) {
        const box = kernel.getBoundingBox(shape);
        bounds = { min: [box.xmin, box.ymin, box.zmin], max: [box.xmax, box.ymax, box.zmax] };
      }
      components.push({ path: node.path, name: node.name, depth: node.depth, bodies: count, firstBody, bounds, color: node.color ? [...node.color] : undefined });
    }
    return { bodies: fileSolids(kernel, doc).length, components, unlisted };
  } finally {
    kernel.releaseSince(mark);
  }
}

/** One or two sentences' worth of names for an error message. */
function nameList(names: string[]) {
  const shown = names.slice(0, 12).join(', ');
  return names.length > 12 ? `${shown}, and ${names.length - 12} more` : shown;
}

/** The solids of one named component, as one shape in the file's frame. The caller holds a checkpoint. */
export function pickComponent(kernel: OcctKernel, doc: XCAFDocument, file: string, path: string): { shape: ShapeHandle; bodies: number; color?: [number, number, number] } {
  const names: string[] = [];
  for (const node of walk(kernel, doc)) {
    if (node.path !== path) {
      names.push(node.path);
      continue;
    }
    const solids = solidsOf(kernel, placed(kernel, doc, node));
    if (!solids.length) throw new SelectionError(`The component "${path}" in ${file} has no solid bodies. It may hold only surfaces or curves.`);
    return { shape: solids.length === 1 ? solids[0] : kernel.makeCompound(solids), bodies: solids.length, color: node.color };
  }
  if (names.length) throw new SelectionError(`${file} has no component "${path}". It has: ${nameList(names)}.`);
  const bodies = fileSolids(kernel, doc).length;
  throw new SelectionError(`${file} has no named components. Use body (${bodies > 1 ? `1 to ${bodies}` : 'only 1'}) to pick a solid body, or leave component out for the whole file.`);
}

/** One solid body, counted from 1 in file order. The caller holds a checkpoint. */
export function pickBody(kernel: OcctKernel, doc: XCAFDocument, file: string, number: number): { shape: ShapeHandle; bodies: number; color?: [number, number, number] } {
  const solids = fileSolids(kernel, doc);
  if (!Number.isInteger(number) || number < 1 || number > solids.length) {
    throw new SelectionError(`${file} has ${solids.length} solid ${solids.length === 1 ? 'body' : 'bodies'}. body can be ${solids.length > 1 ? `1 to ${solids.length}` : 'only 1'}.`);
  }
  // The colour comes from the component the body belongs to.
  let color: [number, number, number] | undefined;
  let seen = 0;
  for (const node of walk(kernel, doc)) {
    if (!node.leaf) continue;
    const count = solidsOf(kernel, placed(kernel, doc, node)).length;
    if (number <= seen + count) {
      color = node.color;
      break;
    }
    seen += count;
  }
  return { shape: solids[number - 1], bodies: 1, color };
}

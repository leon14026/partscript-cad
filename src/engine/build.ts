import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { partTag, readAssembly, singlePart, solvePose, type AssemblySpec, type Color } from './assembly.ts';
import { childrenText, firstColor, hasShapes, needsCheck, parseCsg, taggedParts, unsupported, type CsgNode } from './csg.ts';
import { maxTriangles, meshBounds, meshVolume, parseBinaryStl, toPartMesh } from './mesh.ts';
import { CadError, type BuildStage, type ModelPreview, type PartMesh, type Pose, type ProjectFiles } from './protocol.ts';
import { checkProject, evaluateScad, renderMesh, type Evaluation, type LibraryFiles, type LibraryLoader, type OpenScadFactory } from './scad.ts';
import { buildSolid, meshToSolid, previewSolid, writeAssemblyStep } from './solid.ts';

/** Why a part is faceted when its exact build disagreed with OpenSCAD. It reads after "uses". */
export const mismatchReason = "an exact build that did not match OpenSCAD's mesh";

/** Every `$fn = 0, $fa = X, $fs = Y` in a dump, which a finer mesh replaces. */
const smoothSettings = /\$fn = 0, \$fa = [^,)]+, \$fs = [^,)]+/g;
const fineMeshLimit = 400_000;

/**
 * A built part. An exact part is an OpenCascade solid made from boxes, cylinders,
 * spheres and Booleans. A faceted part is the mesh OpenSCAD made for anything
 * else. Its solid is only made when STEP is exported.
 */
type CachedSolid = (
  | { kind: 'exact'; shape: ShapeHandle; mesh: PartMesh }
  | { kind: 'faceted'; stl: Uint8Array; mesh: PartMesh; shape?: ShapeHandle }
) & {
  /** The first color() in the part's shapes, used when part() gives no color. */
  color?: Color;
};

/**
 * Pair each inline part, in order, with the render node that holds its shapes.
 * A part whose shapes produce nothing has no node, which is how it is found.
 */
function inlineShapes(assembly: AssemblySpec, tagged: ReturnType<typeof taggedParts>) {
  const shapes = new Map<number, CsgNode>();
  let next = 0;
  assembly.parts.forEach((part, i) => {
    if (!part.inline) return;
    const found = tagged[next];
    if (!found || found.tag !== partTag(part.name) || !hasShapes(found.node.children)) {
      throw new CadError(`part("${part.name}"): its shapes produce nothing.`);
    }
    if (found.wrapper) {
      throw new CadError(`part("${part.name}"): an operation such as translate() or difference() wraps this part() call. Move it inside the braces, or use at and rot on part().`);
    }
    shapes.set(i, found.node);
    next++;
  });
  if (next !== tagged.length) throw new CadError('The parts in braces could not be matched to their shapes. Give each part() a different name.');
  return shapes;
}

export interface BuiltModel {
  name: string;
  assembly: AssemblySpec;
  /** One entry per entry of assembly.parts. Parts with the same shapes share an entry. */
  entries: CachedSolid[];
  preview: ModelPreview;
}

/**
 * Builds a project file into solids. Solids are kept between builds and keyed
 * by the geometry OpenSCAD evaluated, so editing one part of an assembly
 * leaves the other parts untouched.
 */
export class ModelBuilder {
  #kernel: OcctKernel;
  #createOpenScad: OpenScadFactory;
  #loadLibrary?: LibraryLoader;
  #buildExact: typeof buildSolid;
  #cache = new Map<string, CachedSolid>();

  /**
   * `loadLibrary` fetches a library such as BOSL2 when a project includes it. Without one, libraries are unavailable.
   * `buildExact` makes the exact solid of a tree. Only the tests pass one, to check what happens when it is wrong.
   */
  constructor(kernel: OcctKernel, createOpenScad: OpenScadFactory, loadLibrary?: LibraryLoader, buildExact: typeof buildSolid = buildSolid) {
    this.#kernel = kernel;
    this.#createOpenScad = createOpenScad;
    this.#loadLibrary = loadLibrary;
    this.#buildExact = buildExact;
  }

  /** Fetch the libraries a project includes. Only those are mounted, so other projects stay fast. */
  async #libraries(names: string[], progress: (stage: BuildStage) => void) {
    const mounted: Record<string, LibraryFiles> = {};
    if (names.length === 0) return mounted;
    if (!this.#loadLibrary) throw new CadError(`${names.join(', ')} cannot be loaded here. Remove the include line, or use the site.`);
    progress('load');
    for (const name of names) mounted[name] = await this.#loadLibrary(name);
    return mounted;
  }

  /** The exact solid of a tree that unsupported() accepted. */
  #exact(nodes: CsgNode[]): Extract<CachedSolid, { kind: 'exact' }> {
    const kernel = this.#kernel;
    const mark = kernel.checkpoint();
    let brep: Uint8Array;
    let mesh: PartMesh;
    try {
      const { shape, volume } = this.#buildExact(kernel, nodes);
      mesh = { ...previewSolid(kernel, shape), volume, quality: 'exact' };
      brep = kernel.toBREPBinary(shape);
    } finally {
      // Boolean operations leave many intermediate shapes. Keep only the result.
      kernel.releaseSince(mark);
    }
    return { kind: 'exact', shape: kernel.fromBREPBinary(brep), mesh };
  }

  /**
   * Compare an exact part with OpenSCAD's mesh of the same shapes: volume within
   * 0.3% and every bounding-box number within 0.05 mm. The mesh is made finer than
   * the part's own facet settings so curves are close to true. A very large fine
   * mesh is skipped for the part's own, with 2% and 0.5 mm.
   */
  async #agrees(csg: string, exact: PartMesh) {
    let stl = await renderMesh(csg.replace(smoothSettings, '$fn = 0, $fa = 1, $fs = 0.05'), this.#createOpenScad);
    let loose = false;
    if (new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true) > fineMeshLimit) {
      stl = await renderMesh(csg, this.#createOpenScad);
      loose = true;
    }
    const soup = parseBinaryStl(stl);
    const volume = meshVolume(soup);
    const { min, max } = meshBounds(soup);
    const relative = loose ? 0.02 : 0.003;
    const millimetres = loose ? 0.5 : 0.05;
    const sameVolume = Math.abs(exact.volume - volume) <= relative * Math.abs(volume);
    const sameBox = [0, 1, 2].every((k) => Math.abs(exact.bounds.min[k] - min[k]) <= millimetres && Math.abs(exact.bounds.max[k] - max[k]) <= millimetres);
    if (!sameVolume || !sameBox) {
      console.warn(`The exact build has volume ${exact.volume} and the OpenSCAD mesh ${volume}. Bounds ${JSON.stringify(exact.bounds)} against ${JSON.stringify({ min, max })}.`);
    }
    return sameVolume && sameBox;
  }

  /** Build the solid for one part's shapes. `context` names an inline part in error messages. */
  async #solid(csg: string, file: string, context?: string): Promise<{ solid: CachedSolid; fresh: boolean }> {
    const cached = this.#cache.get(csg);
    if (cached) return { solid: cached, fresh: false };

    try {
      const nodes = parseCsg(csg);
      let reason = unsupported(nodes);
      let solid: CachedSolid | undefined;
      if (reason === undefined) {
        // An extrusion, prism or scaled shape is new ground: trust it only where OpenSCAD's own mesh agrees.
        const checked = needsCheck(nodes);
        try {
          solid = this.#exact(nodes);
          if (checked && !(await this.#agrees(csg, solid.mesh))) {
            this.#kernel.release(solid.shape);
            solid = undefined;
            reason = mismatchReason;
          }
        } catch (error) {
          if (!checked) throw error;
          console.warn(`The exact build failed, so ${context ?? file} is faceted:`, error instanceof Error ? error.message : error);
          solid = undefined;
          reason = mismatchReason;
        }
      }
      if (!solid) {
        const stl = await renderMesh(csg, this.#createOpenScad);
        let soup;
        try {
          soup = parseBinaryStl(stl);
        } catch {
          throw new CadError('OpenSCAD returned a mesh that could not be read.');
        }
        const volume = meshVolume(soup);
        if (!Number.isFinite(volume) || volume <= 0) throw new CadError('This model has no positive solid volume.');
        const shown = toPartMesh(soup);
        if (!shown.indices.length || shown.indices.length / 3 > maxTriangles) {
          throw new CadError('The solid is too complex to preview. Reduce the number of features.');
        }
        solid = { kind: 'faceted', stl, mesh: { ...shown, volume, quality: 'faceted', reason } };
      }
      solid.color = firstColor(nodes);
      this.#cache.set(csg, solid);
      return { solid, fresh: true };
    } catch (error) {
      if (!(error instanceof CadError) || error.file) throw error;
      throw new CadError(context ? `${context}: ${error.message}` : error.message, error.line, file);
    }
  }

  async build(files: ProjectFiles, entry: string, progress: (stage: BuildStage) => void = () => {}): Promise<BuiltModel> {
    const started = performance.now();
    const mounted = await this.#libraries(checkProject(files, entry), progress);
    progress('evaluate');
    const main = await evaluateScad(files, entry, this.#createOpenScad, mounted);
    const isAssembly = main.records.length > 0;
    let assembly: AssemblySpec;
    let inline = new Map<number, CsgNode>();
    if (isAssembly) {
      try {
        assembly = readAssembly(main.records);
        for (const part of assembly.parts) {
          if (part.file === undefined) continue;
          if (!Object.hasOwn(files, part.file)) throw new CadError(`part("${part.name}"): ${part.file} is not in this project.`);
          if (part.file === entry) throw new CadError(`part("${part.name}"): an assembly cannot use itself as a part.`);
        }
        const nodes = parseCsg(main.csg);
        if (hasShapes(nodes, true)) {
          throw new CadError('This file declares parts and also draws shapes outside them. Move the shapes into a part file, or into the braces of a part() call.');
        }
        inline = inlineShapes(assembly, taggedParts(nodes));
      } catch (error) {
        throw error instanceof CadError && !error.file ? new CadError(error.message, error.line, entry) : error;
      }
    } else {
      assembly = singlePart(entry);
    }

    const evaluations = new Map<string, Evaluation>([[entry, main]]);
    const messages = [...main.messages];
    for (const { file } of assembly.parts) {
      if (file === undefined || evaluations.has(file)) continue;
      const evaluation = await evaluateScad(files, file, this.#createOpenScad, mounted);
      if (evaluation.records.length) {
        throw new CadError(`${file} declares parts of its own. An assembly inside an assembly is unavailable in this version.`, undefined, file);
      }
      evaluations.set(file, evaluation);
      for (const message of evaluation.messages) if (messages.length < 12) messages.push(message);
    }

    progress('model');
    const used = new Set<CachedSolid>();
    const meshes: PartMesh[] = [];
    const meshIndex = new Map<CachedSolid, number>();
    const entries: CachedSolid[] = [];
    const partMesh: number[] = [];
    let rebuilt = 0;
    for (const [i, part] of assembly.parts.entries()) {
      const node = inline.get(i);
      const { solid, fresh } = node
        ? await this.#solid(childrenText(main.csg, node), entry, `part("${part.name}")`)
        : await this.#solid(evaluations.get(part.file!)!.csg, part.file!);
      if (fresh) rebuilt++;
      if (!part.colorGiven && solid.color) part.color = solid.color;
      used.add(solid);
      if (!meshIndex.has(solid)) {
        meshIndex.set(solid, meshes.length);
        meshes.push(solid.mesh);
      }
      entries.push(solid);
      partMesh.push(meshIndex.get(solid)!);
    }
    progress('mesh');

    // Drop solids this model no longer uses.
    for (const [csg, solid] of this.#cache) {
      if (used.has(solid)) continue;
      if (solid.shape) this.#kernel.release(solid.shape);
      this.#cache.delete(csg);
    }

    return {
      name: entry.replace(/\.scad$/i, ''),
      assembly,
      entries,
      preview: { assembly, isAssembly, meshes, partMesh, messages, rebuilt, buildMs: performance.now() - started },
    };
  }

  /** The OpenCascade solid of an entry. A faceted part is sewn from its mesh the first time. */
  #shape(entry: CachedSolid, label: string): ShapeHandle {
    if (entry.kind === 'exact') return entry.shape;
    entry.shape ??= meshToSolid(this.#kernel, entry.stl, entry.mesh.volume, label);
    return entry.shape;
  }

  exportStep(model: BuiltModel, pose: Pose = {}) {
    const solids = model.entries.map((entry, i) => this.#shape(entry, model.assembly.parts[i].file ?? model.assembly.parts[i].name));
    return writeAssemblyStep(this.#kernel, model.name, model.assembly, solids, solvePose(model.assembly, pose));
  }
}

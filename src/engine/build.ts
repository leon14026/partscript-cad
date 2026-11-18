import type { OcctKernel, ShapeHandle, XCAFDocument } from 'occt-wasm';
import { partTag, readAssembly, singlePart, solvePose, type AssemblySpec, type Color, type PartSpec } from './assembly.ts';
import { assetFormat, contentHash, stemOf } from './assets.ts';
import { childrenText, firstColor, flatRounds, hasShapes, needsCheck, parseCsg, taggedParts, unsupported, type CsgNode } from './csg.ts';
import { flipTriangles, maxTriangles, meshBounds, meshVolume, parseBinaryStl, parseStl, toBinaryStl, toPartMesh } from './mesh.ts';
import { CadError, type BuildStage, type CollisionAnswer, type CollisionTest, type MeasurePick, type ModelPreview, type PartMesh, type Pose, type ProjectAssets, type ProjectFiles, type StepStructure } from './protocol.ts';
import { measure } from './measure.ts';
import { evaluateScad, inspectProject, renderMesh, type Evaluation, type LibraryFiles, type LibraryLoader, type OpenScadFactory } from './scad.ts';
import { buildSolid, meshToSolid, previewSolid, writeAssemblyStep } from './solid.ts';
import { fileSolids, pickBody, pickComponent, readStructure, SelectionError } from './stepTree.ts';

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
  /** What each STEP file holds, by the hash of its bytes. Kept while a build uses the file. */
  #structures = new Map<string, StepStructure>();

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

  /**
   * Store a solid the way the cache keeps one: serialised and read back, so that what is kept holds nothing from
   * the construction, and meshed from the stored shape, so the faces, edges and corners the mesh numbers are
   * the ones the measure command finds in it.
   */
  #keep(make: () => { shape: ShapeHandle; volume: number }, imported = false): Extract<CachedSolid, { kind: 'exact' }> {
    const kernel = this.#kernel;
    const mark = kernel.checkpoint();
    let brep: Uint8Array;
    let volume: number;
    try {
      const built = make();
      volume = built.volume;
      brep = kernel.toBREPBinary(built.shape);
    } finally {
      // Boolean operations leave many intermediate shapes. Keep only the result.
      kernel.releaseSince(mark);
    }
    const shape = kernel.fromBREPBinary(brep);
    const inner = kernel.checkpoint();
    try {
      return { kind: 'exact', shape, mesh: { ...previewSolid(kernel, shape, imported), volume, quality: 'exact' } };
    } catch (error) {
      kernel.release(shape);
      throw error;
    } finally {
      kernel.releaseSince(inner);
    }
  }

  /** The exact solid of a tree that unsupported() accepted. */
  #exact(nodes: CsgNode[]) {
    return this.#keep(() => this.#buildExact(this.#kernel, nodes));
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
  async #solid(csg: string, file: string, context?: string, assets: ProjectAssets = {}): Promise<{ solid: CachedSolid; fresh: boolean }> {
    // An import() names its STL, and the dump adds the file's modification time. Key the part by the file's content instead, so
    // an unchanged part is not rebuilt and a replaced file is.
    const meshes: ProjectAssets = {};
    let key = csg;
    for (const match of csg.matchAll(/\bimport\(file = "\/([^"]+)"/g)) {
      const bytes = assets[match[1]];
      if (!bytes) throw new CadError(`${match[1]} is not in this project.`, undefined, file);
      meshes[match[1]] = bytes;
    }
    const imported = Object.keys(meshes);
    if (imported.length) {
      key = csg.replace(/, timestamp = \d+/g, '');
      for (const name of imported) key += `\n// ${name} ${await contentHash(meshes[name])}`;
    }
    const cached = this.#cache.get(key);
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
        if (reason === 'import') reason = 'an imported STL mesh';
        const stl = await renderMesh(csg, this.#createOpenScad, meshes);
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
      if (solid.kind === 'exact') {
        const rounds = flatRounds(nodes);
        if (rounds.length) solid.mesh.flatRounds = rounds;
      }
      this.#cache.set(key, solid);
      return { solid, fresh: true };
    } catch (error) {
      if (!(error instanceof CadError) || error.file) throw error;
      throw new CadError(context ? `${context}: ${error.message}` : error.message, error.line, file);
    }
  }

  /**
   * The solid of an imported STEP or STL, built once for each distinct content. A part that names a component or
   * a body of a STEP file gets that piece, cached on its own. `docs` holds the files read in this build, so a
   * file that gives several parts is read once.
   */
  async #asset(name: string, bytes: Uint8Array, part: PartSpec | undefined, docs: Map<string, XCAFDocument>): Promise<{ solid: CachedSolid; fresh: boolean }> {
    const format = assetFormat(name);
    const hash = await contentHash(bytes);
    const piece = part?.component !== undefined ? `#component=${part.component}` : part?.body !== undefined ? `#body=${part.body}` : '';
    const key = `${format}:${hash}${piece}`;
    const cached = this.#cache.get(key);
    if (cached) return { solid: cached, fresh: false };
    const solid = format === 'step' ? this.#importStep(name, bytes, hash, docs, part) : this.#importStl(name, bytes);
    this.#cache.set(key, solid);
    return { solid, fresh: true };
  }

  /**
   * A STEP file as an exact part: its solid bodies joined as one compound, or the one component or body that
   * part() picks. OpenCascade converts the file's units to millimetres. The file is read through an XCAF
   * document, which gives the solids in file order, their places, and the names and colours of the components.
   */
  #importStep(name: string, bytes: Uint8Array, hash: string, docs: Map<string, XCAFDocument>, part?: PartSpec): CachedSolid {
    const kernel = this.#kernel;
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*ISO-10303-21\s*;/.test(text.slice(0, 4096))) {
      throw new CadError(`${name} is not a STEP file: it does not start with ISO-10303-21. It may be another format that was renamed. Export it from the CAD program as STEP (AP203, AP214 or AP242).`, undefined, name);
    }
    try {
      // The document is opened here, before any checkpoint, because releasing handles must not reach into it.
      let doc = docs.get(hash);
      if (!doc) {
        try {
          doc = kernel.importXCAFFromSTEP(text);
        } catch {
          throw new CadError(`${name} could not be read as a STEP file. It may be damaged or cut short. Export it again from the CAD program as STEP (AP203, AP214 or AP242).`, undefined, name);
        }
        docs.set(hash, doc);
      }
      if (!this.#structures.has(hash)) this.#structures.set(hash, readStructure(kernel, doc));
      let bodies = 0;
      let color: Color | undefined;
      const kept = this.#keep(() => {
        let shape: ShapeHandle;
        if (part?.component !== undefined) {
          ({ shape, bodies, color } = pickComponent(kernel, doc, name, part.component));
        } else if (part?.body !== undefined) {
          ({ shape, bodies, color } = pickBody(kernel, doc, name, part.body));
        } else {
          const solids = fileSolids(kernel, doc);
          if (!solids.length) throw new CadError(`${name} has no solid bodies. It may contain only surfaces or curves. Export it again as a solid model.`, undefined, name);
          shape = solids.length === 1 ? solids[0] : kernel.makeCompound(solids);
          bodies = solids.length;
        }
        const volume = kernel.getVolume(shape);
        if (!Number.isFinite(volume) || volume <= 0) throw new CadError(`${name} has no positive solid volume.`, undefined, name);
        return { shape, volume };
      }, true);
      kept.mesh.bodies = bodies;
      if (color) kept.color = color;
      return kept;
    } catch (error) {
      if (error instanceof SelectionError) throw error;
      throw error instanceof CadError && !error.file ? new CadError(error.message, error.line, name) : error;
    }
  }

  /** An STL as a faceted part. A mesh whose triangles face inward is turned around. */
  #importStl(name: string, bytes: Uint8Array): CachedSolid {
    let soup;
    try {
      soup = parseStl(bytes);
    } catch (error) {
      throw new CadError(`${name} could not be read. ${error instanceof Error ? error.message : ''}`.trim(), undefined, name);
    }
    let volume = meshVolume(soup);
    if (volume < 0) {
      soup = flipTriangles(soup);
      volume = -volume;
    }
    if (!Number.isFinite(volume) || volume < 1e-6) {
      throw new CadError(`${name} does not enclose a volume. An STL has to be a closed solid: with no holes in its surface, and all triangles facing outward.`, undefined, name);
    }
    const stats = { openEdges: 0 };
    const shown = toPartMesh(soup, undefined, stats);
    const triangles = shown.indices.length / 3;
    if (!triangles || triangles > maxTriangles) {
      throw new CadError(`${name} has ${triangles.toLocaleString('en-US')} triangles, and a part can have up to ${maxTriangles.toLocaleString('en-US')} to be previewed. Export a coarser mesh.`, undefined, name);
    }
    // STEP is made from a binary STL, so keep one whatever the file was.
    // A mesh with open edges still shows and measures, but its volume is not a volume and STEP export will say it cannot sew it.
    const reason = stats.openEdges ? `an imported STL mesh that is not closed (${stats.openEdges.toLocaleString('en-US')} open edges)` : 'an imported STL mesh';
    return { kind: 'faceted', stl: toBinaryStl(soup), mesh: { ...shown, volume, quality: 'faceted', reason } };
  }

  /** An imported part's solid. A component or body that the file does not have is an error in the part() call. */
  async #partAsset(part: PartSpec, bytes: Uint8Array, docs: Map<string, XCAFDocument>, entry: string) {
    try {
      return await this.#asset(part.file!, bytes, part, docs);
    } catch (error) {
      if (error instanceof SelectionError) throw new CadError(`part("${part.name}"): ${error.message}`, undefined, entry);
      throw error;
    }
  }

  async build(files: ProjectFiles, entry: string, progress: (stage: BuildStage) => void = () => {}, assets: ProjectAssets = {}): Promise<BuiltModel> {
    const started = performance.now();
    const needs = inspectProject(files, entry, assets);
    const mounted = await this.#libraries(needs.libraries, progress);
    // The STL files that import() reads are written next to the project files when OpenSCAD runs.
    const importedMeshes: ProjectAssets = Object.fromEntries(needs.meshes.map((name) => [name, assets[name]]));
    progress('evaluate');
    // An asset can be built on its own, to look at it and measure it.
    const main = Object.hasOwn(assets, entry) ? undefined : await evaluateScad(files, entry, this.#createOpenScad, mounted, importedMeshes);
    const isAssembly = main !== undefined && main.records.length > 0;
    let assembly: AssemblySpec;
    let inline = new Map<number, CsgNode>();
    if (isAssembly) {
      try {
        assembly = readAssembly(main.records);
        for (const part of assembly.parts) {
          if (part.file === undefined) continue;
          if (!Object.hasOwn(files, part.file) && !Object.hasOwn(assets, part.file)) throw new CadError(`part("${part.name}"): ${part.file} is not in this project.`);
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

    const evaluations = new Map<string, Evaluation>(main ? [[entry, main]] : []);
    const messages = main ? [...main.messages] : [];
    for (const { file } of assembly.parts) {
      if (file === undefined || evaluations.has(file) || Object.hasOwn(assets, file)) continue;
      const evaluation = await evaluateScad(files, file, this.#createOpenScad, mounted, importedMeshes);
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
    // STEP files read in this build, by content hash, so a file that gives several parts is read once.
    const docs = new Map<string, XCAFDocument>();
    try {
    for (const [i, part] of assembly.parts.entries()) {
      const node = inline.get(i);
      const { solid, fresh } = node
        ? await this.#solid(childrenText(main!.csg, node), entry, `part("${part.name}")`, assets)
        : part.file !== undefined && Object.hasOwn(assets, part.file)
          ? await this.#partAsset(part, assets[part.file], docs, entry)
          : await this.#solid(evaluations.get(part.file!)!.csg, part.file!, undefined, assets);
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
    } finally {
      for (const doc of docs.values()) doc.close();
    }
    progress('mesh');

    // What each STEP file used here holds, for the asset panel. Files this build did not use are forgotten.
    const steps: Record<string, StepStructure> = {};
    const usedHashes = new Set<string>();
    for (const part of assembly.parts) {
      if (part.file === undefined || !Object.hasOwn(assets, part.file) || assetFormat(part.file) !== 'step') continue;
      const hash = await contentHash(assets[part.file]);
      usedHashes.add(hash);
      const structure = this.#structures.get(hash);
      if (structure) steps[part.file] = structure;
    }
    for (const hash of [...this.#structures.keys()]) if (!usedHashes.has(hash)) this.#structures.delete(hash);

    // Drop solids this model no longer uses.
    for (const [csg, solid] of this.#cache) {
      if (used.has(solid)) continue;
      if (solid.shape) this.#kernel.release(solid.shape);
      this.#cache.delete(csg);
    }

    return {
      name: stemOf(entry),
      assembly,
      entries,
      preview: { assembly, isAssembly, meshes, partMesh, messages, rebuilt, buildMs: performance.now() - started, steps },
    };
  }

  /** The OpenCascade solid of an entry. A faceted part is sewn from its mesh the first time. */
  #shape(entry: CachedSolid, label: string): ShapeHandle {
    if (entry.kind === 'exact') return entry.shape;
    entry.shape ??= meshToSolid(this.#kernel, entry.stl, entry.mesh.volume, label);
    return entry.shape;
  }

  /** Read one or two picks of a built model in a pose. Holds no handles afterwards. */
  measure(model: BuiltModel, pose: Pose, picks: MeasurePick[]) {
    const matrices = solvePose(model.assembly, pose);
    const parts = model.entries.map((entry, i) => ({
      name: model.assembly.parts[i].name,
      matrix: matrices[i],
      mesh: entry.mesh,
      shape: entry.kind === 'exact' ? entry.shape : undefined,
    }));
    const mark = this.#kernel.checkpoint();
    try {
      return measure(this.#kernel, parts, picks);
    } finally {
      this.#kernel.releaseSince(mark);
    }
  }

  /**
   * The exact overlap volume of pairs of parts, from the kernel's common of the two placed solids. A pair with a faceted part has no
   * solid (sewing one takes seconds), so its answer is null. Stops asking when `budgetMs` has passed. Holds no handles afterwards.
   */
  collide(model: BuiltModel, tests: CollisionTest[], budgetMs = 40_000): CollisionAnswer {
    const started = performance.now();
    const volumes: (number | null)[][] = [];
    let complete = true;
    const mark = this.#kernel.checkpoint();
    try {
      for (const test of tests) {
        const matrices = solvePose(model.assembly, test.pose);
        const row: (number | null)[] = [];
        volumes.push(row);
        for (const [a, b] of test.pairs) {
          const [x, y] = [model.entries[a], model.entries[b]];
          if (complete && performance.now() - started > budgetMs) complete = false;
          if (!complete || x.kind !== 'exact' || y.kind !== 'exact') {
            row.push(null);
            continue;
          }
          const inner = this.#kernel.checkpoint();
          try {
            const common = this.#kernel.common(this.#kernel.located(x.shape, matrices[a]), this.#kernel.located(y.shape, matrices[b]));
            row.push(this.#kernel.getVolume(common));
          } catch {
            row.push(null);
          } finally {
            this.#kernel.releaseSince(inner);
          }
        }
      }
    } finally {
      this.#kernel.releaseSince(mark);
    }
    return { volumes, complete };
  }

  exportStep(model: BuiltModel, pose: Pose = {}) {
    const solids = model.entries.map((entry, i) => this.#shape(entry, model.assembly.parts[i].file ?? model.assembly.parts[i].name));
    return writeAssemblyStep(this.#kernel, model.name, model.assembly, solids, solvePose(model.assembly, pose));
  }
}

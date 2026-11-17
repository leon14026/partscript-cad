import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { readAssembly, singlePart, solvePose, type AssemblySpec } from './assembly.ts';
import { hasShapes, parseCsg, unsupported } from './csg.ts';
import { maxTriangles, meshVolume, parseBinaryStl, toPartMesh } from './mesh.ts';
import { CadError, type BuildStage, type ModelPreview, type PartMesh, type Pose, type ProjectFiles } from './protocol.ts';
import { checkProject, evaluateScad, renderMesh, type Evaluation, type OpenScadFactory } from './scad.ts';
import { buildSolid, meshToSolid, previewSolid, writeAssemblyStep } from './solid.ts';

/**
 * A built part. An exact part is an OpenCascade solid made from boxes, cylinders,
 * spheres and Booleans. A faceted part is the mesh OpenSCAD made for anything
 * else. Its solid is only made when STEP is exported.
 */
type CachedSolid =
  | { kind: 'exact'; shape: ShapeHandle; mesh: PartMesh }
  | { kind: 'faceted'; stl: Uint8Array; mesh: PartMesh; shape?: ShapeHandle };

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
  #cache = new Map<string, CachedSolid>();

  constructor(kernel: OcctKernel, createOpenScad: OpenScadFactory) {
    this.#kernel = kernel;
    this.#createOpenScad = createOpenScad;
  }

  async #solid(csg: string, file: string): Promise<{ solid: CachedSolid; fresh: boolean }> {
    const cached = this.#cache.get(csg);
    if (cached) return { solid: cached, fresh: false };

    try {
      const nodes = parseCsg(csg);
      const reason = unsupported(nodes);
      let solid: CachedSolid;
      if (reason === undefined) {
        const kernel = this.#kernel;
        const mark = kernel.checkpoint();
        let brep: Uint8Array;
        let mesh: PartMesh;
        try {
          const { shape, volume } = buildSolid(kernel, nodes);
          mesh = { ...previewSolid(kernel, shape), volume, quality: 'exact' };
          brep = kernel.toBREPBinary(shape);
        } finally {
          // Boolean operations leave many intermediate shapes. Keep only the result.
          kernel.releaseSince(mark);
        }
        solid = { kind: 'exact', shape: kernel.fromBREPBinary(brep), mesh };
      } else {
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
      this.#cache.set(csg, solid);
      return { solid, fresh: true };
    } catch (error) {
      throw error instanceof CadError && !error.file ? new CadError(error.message, error.line, file) : error;
    }
  }

  async build(files: ProjectFiles, entry: string, progress: (stage: BuildStage) => void = () => {}): Promise<BuiltModel> {
    const started = performance.now();
    checkProject(files, entry);
    progress('evaluate');
    const main = await evaluateScad(files, entry, this.#createOpenScad);
    const isAssembly = main.records.length > 0;
    let assembly: AssemblySpec;
    if (isAssembly) {
      try {
        assembly = readAssembly(main.records);
        for (const part of assembly.parts) {
          if (!Object.hasOwn(files, part.file)) throw new CadError(`part("${part.name}"): ${part.file} is not in this project.`);
          if (part.file === entry) throw new CadError(`part("${part.name}"): an assembly cannot use itself as a part.`);
        }
        if (hasShapes(parseCsg(main.csg))) {
          throw new CadError('This file declares parts and also draws shapes. Move the shapes into a part file.');
        }
      } catch (error) {
        throw error instanceof CadError && !error.file ? new CadError(error.message, error.line, entry) : error;
      }
    } else {
      assembly = singlePart(entry);
    }

    const evaluations = new Map<string, Evaluation>([[entry, main]]);
    const messages = [...main.messages];
    for (const { file } of assembly.parts) {
      if (evaluations.has(file)) continue;
      const evaluation = await evaluateScad(files, file, this.#createOpenScad);
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
    for (const { file } of assembly.parts) {
      const { csg } = evaluations.get(file)!;
      const { solid, fresh } = await this.#solid(csg, file);
      if (fresh) rebuilt++;
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
    const solids = model.entries.map((entry, i) => this.#shape(entry, model.assembly.parts[i].file));
    return writeAssemblyStep(this.#kernel, model.name, model.assembly, solids, solvePose(model.assembly, pose));
  }
}

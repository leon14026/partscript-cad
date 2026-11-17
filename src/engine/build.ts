import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import { readAssembly, singlePart, solvePose, type AssemblySpec } from './assembly.ts';
import { hasShapes, parseCsg } from './csg.ts';
import { CadError, type BuildStage, type ModelPreview, type PartMesh, type Pose, type ProjectFiles } from './protocol.ts';
import { checkProject, evaluateScad, type Evaluation, type OpenScadFactory } from './scad.ts';
import { buildSolid, previewSolid, writeAssemblyStep } from './solid.ts';

interface CachedSolid {
  shape: ShapeHandle;
  mesh: PartMesh;
}

export interface BuiltModel {
  name: string;
  assembly: AssemblySpec;
  /** One solid per entry of assembly.parts. Parts from the same file share a handle. */
  solids: ShapeHandle[];
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

  #solid(csg: string, file: string): { solid: CachedSolid; fresh: boolean } {
    const cached = this.#cache.get(csg);
    if (cached) return { solid: cached, fresh: false };

    const kernel = this.#kernel;
    const mark = kernel.checkpoint();
    let brep: Uint8Array;
    let mesh: PartMesh;
    try {
      const { shape, volume } = buildSolid(kernel, csg);
      mesh = { ...previewSolid(kernel, shape), volume };
      brep = kernel.toBREPBinary(shape);
    } catch (error) {
      throw error instanceof CadError && !error.file ? new CadError(error.message, error.line, file) : error;
    } finally {
      // Boolean operations leave many intermediate shapes. Keep only the result.
      kernel.releaseSince(mark);
    }
    const solid = { shape: kernel.fromBREPBinary(brep), mesh };
    this.#cache.set(csg, solid);
    return { solid, fresh: true };
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
    const used = new Map<string, CachedSolid>();
    const meshes: PartMesh[] = [];
    const meshIndex = new Map<CachedSolid, number>();
    const solids: ShapeHandle[] = [];
    const partMesh: number[] = [];
    let rebuilt = 0;
    for (const { file } of assembly.parts) {
      const { csg } = evaluations.get(file)!;
      const { solid, fresh } = this.#solid(csg, file);
      if (fresh) rebuilt++;
      used.set(csg, solid);
      if (!meshIndex.has(solid)) {
        meshIndex.set(solid, meshes.length);
        meshes.push(solid.mesh);
      }
      solids.push(solid.shape);
      partMesh.push(meshIndex.get(solid)!);
    }
    progress('mesh');

    // Drop solids this model no longer uses.
    for (const [csg, solid] of this.#cache) {
      if (used.has(csg)) continue;
      this.#kernel.release(solid.shape);
      this.#cache.delete(csg);
    }

    return {
      name: entry.replace(/\.scad$/i, ''),
      assembly,
      solids,
      preview: { assembly, isAssembly, meshes, partMesh, messages, rebuilt, buildMs: performance.now() - started },
    };
  }

  exportStep(model: BuiltModel, pose: Pose = {}) {
    return writeAssemblyStep(this.#kernel, model.name, model.assembly, model.solids, solvePose(model.assembly, pose));
  }
}

import type { AssemblySpec } from './assembly.ts';

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_PROJECT_BYTES = 1024 * 1024;
export const MAX_PROJECT_FILES = 40;
export const JOB_TIMEOUT_MS = 60_000;

export type Vec3 = [number, number, number];
export type BuildStage = 'load' | 'evaluate' | 'model' | 'mesh' | 'export';

/** Project sources by file name. Names are flat, for example `arm.scad`. */
export type ProjectFiles = Record<string, string>;

export interface Diagnostic {
  message: string;
  line?: number;
  file?: string;
}

export class CadError extends Error {
  readonly line?: number;
  readonly file?: string;

  constructor(message: string, line?: number, file?: string) {
    super(message);
    this.name = 'CadError';
    this.line = line;
    this.file = file;
  }
}

/** One built solid. Several parts can share a mesh when they use the same file. */
export interface PartMesh {
  positions: Float32Array<ArrayBuffer>;
  normals: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  edgeSegments: Float32Array<ArrayBuffer>;
  bounds: { min: Vec3; max: Vec3 };
  volume: number;
  /** exact: true curves from OpenCascade. faceted: flat faces from OpenSCAD's own mesh. */
  quality: 'exact' | 'faceted';
  /** For a faceted part, the operation that made it so, for example "hull". */
  reason?: string;
}

export interface ModelPreview {
  /** The parts and joints. A single part file is an assembly of one part. */
  assembly: AssemblySpec;
  /** True when the built file declared parts with part(). */
  isAssembly: boolean;
  meshes: PartMesh[];
  /** Index into meshes for each entry of assembly.parts. */
  partMesh: number[];
  messages: string[];
  buildMs: number;
  /** Solids rebuilt in this job. The rest came from the cache. */
  rebuilt: number;
}

/** Joint values by joint name: degrees for hinges, millimetres for sliders. */
export type Pose = Record<string, number>;

export type GeometryCommand =
  | { kind: 'build'; id: number; revision: number; files: ProjectFiles; entry: string }
  | { kind: 'export'; id: number; revision: number; pose: Pose };

export type GeometryReply =
  | { kind: 'progress'; id: number; stage: BuildStage }
  | { kind: 'preview'; id: number; model: ModelPreview }
  | { kind: 'step'; id: number; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'error'; id: number; diagnostic: Diagnostic };

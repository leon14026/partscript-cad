import type { AssemblySpec } from './assembly.ts';

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_PROJECT_BYTES = 1024 * 1024;
export const MAX_PROJECT_FILES = 40;
/** One imported STEP or STL, and all of a project's imported files together. */
export const MAX_ASSET_BYTES = 40 * 1024 * 1024;
export const MAX_ASSETS_BYTES = 120 * 1024 * 1024;
export const JOB_TIMEOUT_MS = 60_000;

export type Vec3 = [number, number, number];
export type BuildStage = 'load' | 'evaluate' | 'model' | 'mesh' | 'export';

/** Project sources by file name. Names are flat, for example `arm.scad`. */
export type ProjectFiles = Record<string, string>;

/** Imported STEP and STL files by file name, for example `motor.step`. They share the namespace of ProjectFiles. */
export type ProjectAssets = Record<string, Uint8Array>;

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
  /**
   * For the measure tool. The face each triangle belongs to: a face of the solid in an exact part, a smooth
   * region of the mesh (bounded by the drawn edges) in a faceted one.
   */
  faceOf: Uint32Array<ArrayBuffer>;
  /** The edge each segment of edgeSegments belongs to: an edge of the solid. Empty for a faceted part, whose edges are not measured. */
  edgeOf: Uint32Array<ArrayBuffer>;
  /** x, y, z of each corner: the solid's vertices in an exact part, the ends of the drawn edges in a faceted one. */
  corners: Float64Array<ArrayBuffer>;
  bounds: { min: Vec3; max: Vec3 };
  volume: number;
  /** exact: true curves from OpenCascade. faceted: flat faces from OpenSCAD's own mesh. */
  quality: 'exact' | 'faceted';
  /** For a faceted part, the operation that made it so, for example "hull". */
  reason?: string;
  /** For an exact part: the side count of each cylinder or circle that `$fn` made a flat-sided prism, so it is a polygon in STEP. Absent when there are none. */
  flatRounds?: number[];
  /** For a part imported from a STEP file: how many solid bodies the file held. */
  bodies?: number;
}

/** One component of a STEP file's product structure, as the asset panel lists it. */
export interface StepComponent {
  /** The names from the top of the file, joined with "/", such as "arm/link". This is what part(component = ...) takes. */
  path: string;
  /** The last name in the path. */
  name: string;
  /** 0 for a component at the top of the file. */
  depth: number;
  /** Solid bodies in this component. */
  bodies: number;
  /** Number of its first body, counted from 1 in file order. This is what part(body = ...) takes. */
  firstBody: number;
  /** In the file's own frame: where the component sits in the assembly the file holds. */
  bounds: { min: Vec3; max: Vec3 };
  /** The component's own colour, or the nearest one above it. */
  color?: [number, number, number];
}

/** What a STEP file holds, read once for each distinct content. */
export interface StepStructure {
  /** Solid bodies in the whole file. */
  bodies: number;
  /** Every component below the top, depth first. Empty when the file holds one part with no structure. */
  components: StepComponent[];
  /** Components left out of the list because there are too many. They can still be named in part(). */
  unlisted: number;
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
  /** For each STEP file this build used, by file name: what it holds. */
  steps?: Record<string, StepStructure>;
}

/** Joint values by joint name: degrees for hinges, millimetres for sliders. */
export type Pose = Record<string, number>;

/** What a measure pick can land on. An index counts in the order of kernel.getSubShapes, which previewSolid keeps (test/labels.test.ts). */
export type MeasurePickType = 'face' | 'edge' | 'vertex';

export interface MeasurePick {
  /** Index into assembly.parts. */
  part: number;
  type: MeasurePickType;
  index: number;
}

export interface Reading {
  label: string;
  value: number;
  unit: 'mm' | 'mm²' | '°';
}

export interface MeasureResult {
  /** One per pick: what it is and its own readings. */
  items: { title: string; readings: Reading[] }[];
  /** Readings that need both picks. Empty for one pick. */
  between: Reading[];
  /** A line to draw in the preview, in world coordinates: the distance that the first reading of `between` measures. */
  line?: [Vec3, Vec3];
  /** Things the engineer should know, such as why a distance is missing. */
  notes: string[];
}

export type GeometryCommand =
  | {
    kind: 'build'; id: number; revision: number; files: ProjectFiles; entry: string;
    /** The names of all the project's assets. The worker keeps assets between builds and drops those not named here. */
    assetNames: string[];
    /** Only the assets the worker does not hold yet, or that changed. */
    newAssets: ProjectAssets;
  }
  | { kind: 'export'; id: number; revision: number; pose: Pose }
  | { kind: 'measure'; id: number; revision: number; pose: Pose; picks: MeasurePick[] };

export type GeometryReply =
  | { kind: 'progress'; id: number; stage: BuildStage }
  | { kind: 'preview'; id: number; model: ModelPreview }
  | { kind: 'step'; id: number; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'measure'; id: number; result: MeasureResult }
  | { kind: 'error'; id: number; diagnostic: Diagnostic };

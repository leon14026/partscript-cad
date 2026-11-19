/**
 * The plain data of a drawing. Nothing here holds a kernel handle, so all of it crosses from the worker to the page,
 * and everything after the worker (layout, dimensions, the three writers) is pure code that runs in Node as well.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** One curve of a view, in the view's own coordinates: millimetres of the part, x to the right and y up. */
export type Curve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  /** Counterclockwise from `from` to `to`, in radians from the +x direction of the view. */
  | { kind: 'arc'; c: Vec2; r: number; from: number; to: number }
  | { kind: 'poly'; points: Vec2[] };

export type ViewName = 'front' | 'top' | 'right' | 'iso' | 'section';

export interface ViewData {
  name: ViewName;
  visible: Curve[];
  hidden: Curve[];
  /** Hidden curves the view has but did not return, because there are too many to be of any use. */
  hiddenOmitted: number;
  /** Lower left and upper right of the visible curves: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

/** A hole read from the solid. The axis is along x, y or z (0, 1 or 2); other axes are left out of the sheet and named in its notes. */
export interface HoleData {
  axis: 0 | 1 | 2;
  /** The centre of the hole's circle where it opens, in the part's coordinates. */
  at: Vec3;
  diameter: number;
  through: boolean;
  /** From the opening to the floor of a blind hole. For a through hole, the length of the whole hole. */
  depth: number;
  /** A counterbore: the wider part at the opening. */
  bore?: { diameter: number; depth: number };
  /** The side count when the hole is a flat-sided prism that `$fn` made, so the corner circle is its diameter. */
  sides?: number;
}

/** A body of revolution: the external cylinders, along one axis. */
export interface TurnedData {
  axis: 0 | 1 | 2;
  /** Where the axis passes, in the other two coordinates in axis order (for z: x then y). */
  at: Vec2;
  /** Each external cylinder: from and to along the axis, and its diameter. */
  steps: { from: number; to: number; diameter: number }[];
}

export interface SectionData {
  label: string;
  /** The cutting plane is perpendicular to this axis, at this coordinate. */
  axis: 0 | 1 | 2;
  at: number;
  /** The view that gets the cutting-plane line: the one where the hole is a circle. */
  lineIn: ViewName;
  /** Which way the viewer looks: +1 or -1 along the cut axis. */
  looking: 1 | -1;
  view: ViewData;
  /** The outlines of the cut faces in the view's coordinates, as polylines (an outer outline and each hole's outline). */
  outlines: Vec2[][];
  /** The exact area of the cut faces, in mm². */
  area: number;
}

export interface PartDrawing {
  /** The parts that share this geometry. */
  names: string[];
  quantity: number;
  quality: 'exact' | 'faceted';
  /** For a faceted part, what made it faceted, for example "hull". */
  reason?: string;
  /** Read from an imported file. */
  imported: boolean;
  bounds: { min: Vec3; max: Vec3 };
  /** front, top, right and iso, in this order. */
  views: ViewData[];
  holes: HoleData[];
  turned?: TurnedData;
  section?: SectionData;
  /** What the sheet left out, as sentences for the person reading it. */
  notes: string[];
}

export interface AssemblyBalloon {
  /** Item number in the parts list. */
  item: number;
  /** Where the leader touches the part, in the isometric view's coordinates. */
  point: Vec2;
  /** True when no part of the item shows in the view, so the leader goes to its centre. */
  hidden: boolean;
}

export interface AssemblyDrawing {
  /** The model's name, for the title block. */
  name: string;
  view: ViewData;
  balloons: AssemblyBalloon[];
  /** Item number of each entry of the parts list, with its name, quantity and bounding size. */
  items: { item: number; name: string; quantity: number; size: Vec3 }[];
  notes: string[];
}

export interface DrawingResult {
  parts: PartDrawing[];
  assembly?: AssemblyDrawing;
}

export type SheetSize = 'ansi-a' | 'a4' | 'a3' | 'ansi-b';
export type Projection = 'third' | 'first';

export interface TitleFields {
  drawnBy: string;
  date: string;
  revision: string;
  material: string;
}

export interface DrawingOptions {
  size: SheetSize;
  projection: Projection;
  /** Draw hidden lines where the view has them. `auto` follows the limit of `hiddenLineLimit`. */
  hidden: 'auto' | 'on' | 'off';
  title: TitleFields;
}

export type Layer = 'OUTLINE' | 'HIDDEN' | 'DIM' | 'HATCH' | 'TEXT' | 'BORDER';

/** What a writer draws, on the sheet, in millimetres from the lower left corner of the paper. */
export type Entity =
  | { kind: 'line'; layer: Layer; a: Vec2; b: Vec2 }
  | { kind: 'poly'; layer: Layer; points: Vec2[]; closed?: boolean }
  | { kind: 'circle'; layer: Layer; c: Vec2; r: number }
  | { kind: 'arc'; layer: Layer; c: Vec2; r: number; from: number; to: number }
  /** A filled arrowhead whose tip is at `tip`, pointing in the direction `angle` (radians). */
  | { kind: 'arrow'; layer: Layer; tip: Vec2; angle: number }
  | { kind: 'text'; layer: Layer; at: Vec2; text: string; height: number; anchor: 'start' | 'middle' | 'end'; angle: number };

export interface Sheet {
  /** File name without its extension. */
  name: string;
  width: number;
  height: number;
  entities: Entity[];
  /** The scale as printed in the title block, for example "1:2". */
  scale: string;
  /** What the sheet did not dimension, for the page to list. */
  notes: string[];
}

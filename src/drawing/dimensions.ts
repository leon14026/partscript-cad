import { textWidth } from './font.ts';
import type { Curve, Entity, HoleData, Layer, TurnedData, Vec2, ViewData, ViewName } from './types.ts';

/** Sizes on the paper, in millimetres. */
export const style = {
  textHeight: 3,
  smallText: 2.5,
  arrowLength: 3,
  arrowHalfWidth: 0.55,
  /** The gap between a feature and the start of its extension line, and how far the extension line runs past the dimension line. */
  extensionGap: 1,
  extensionOver: 2,
  hatchSpacing: 3,
  lane: 8,
};

export class Paper {
  readonly entities: Entity[] = [];

  line(layer: Layer, a: Vec2, b: Vec2) {
    this.entities.push({ kind: 'line', layer, a, b });
  }

  poly(layer: Layer, points: Vec2[], closed = false) {
    this.entities.push({ kind: 'poly', layer, points, closed });
  }

  circle(layer: Layer, c: Vec2, r: number) {
    this.entities.push({ kind: 'circle', layer, c, r });
  }

  arrow(tip: Vec2, angle: number) {
    this.entities.push({ kind: 'arrow', layer: 'DIM', tip, angle });
  }

  text(layer: Layer, at: Vec2, text: string, height: number, anchor: 'start' | 'middle' | 'end' = 'start', angle = 0) {
    this.entities.push({ kind: 'text', layer, at, text, height, anchor, angle });
  }

  /** A curve of a view, moved to the sheet and scaled. */
  curve(layer: Layer, curve: Curve, map: (p: Vec2) => Vec2, scale: number) {
    if (curve.kind === 'line') this.line(layer, map(curve.a), map(curve.b));
    else if (curve.kind === 'circle') this.circle(layer, map(curve.c), curve.r * scale);
    else if (curve.kind === 'arc') this.entities.push({ kind: 'arc', layer, c: map(curve.c), r: curve.r * scale, from: curve.from, to: curve.to });
    else this.poly(layer, curve.points.map(map));
  }
}

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const length = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => mul(a, 1 / length(a));

/** A number as a drawing shows it: at most two decimals, none when whole. */
export function fmt(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** The angle a line of text reads at: never upside down. */
function readingAngle(direction: Vec2) {
  let angle = Math.atan2(direction[1], direction[0]);
  if (angle > Math.PI / 2 + 1e-9 || angle <= -Math.PI / 2 + 1e-9) angle += Math.PI;
  return angle;
}

/**
 * A dimension between two points, drawn offset from them by `offset` toward the side `normal`. The extension lines run from the
 * points, the arrows sit inside them (outside when the dimension is too short for the arrows and the text) and the value is above the line.
 */
export function linearDimension(paper: Paper, a: Vec2, b: Vec2, normal: Vec2, offset: number, text: string) {
  const along = unit(sub(b, a));
  const n = unit(normal);
  const [start, end] = [add(a, mul(n, offset)), add(b, mul(n, offset))];
  paper.line('DIM', add(a, mul(n, style.extensionGap)), add(start, mul(n, style.extensionOver)));
  paper.line('DIM', add(b, mul(n, style.extensionGap)), add(end, mul(n, style.extensionOver)));
  const span = length(sub(end, start));
  const inside = span >= 2 * style.arrowLength + textWidth(text, style.textHeight) + 2;
  if (inside) {
    paper.line('DIM', start, end);
    paper.arrow(start, Math.atan2(-along[1], -along[0]));
    paper.arrow(end, Math.atan2(along[1], along[0]));
  } else {
    const tail = style.arrowLength + 2;
    paper.line('DIM', add(start, mul(along, -tail)), add(end, mul(along, tail)));
    paper.arrow(start, Math.atan2(along[1], along[0]));
    paper.arrow(end, Math.atan2(-along[1], -along[0]));
  }
  const angle = readingAngle(along);
  const up: Vec2 = [-Math.sin(angle), Math.cos(angle)];
  const middle = add(mul(add(start, end), 0.5), mul(up, 1.2));
  // A dimension too short for its text puts the text beyond the end, along the line.
  const at = inside ? middle : add(add(end, mul(along, style.arrowLength + 3)), mul(up, 1.2));
  paper.text('DIM', at, text, style.textHeight, inside ? 'middle' : 'start', angle);
}

/** Lines at 45 degrees inside the outlines, by the even-odd rule, so a hole inside a face is left clear. Outlines are polylines in sheet coordinates. */
export function hatchLines(outlines: Vec2[][], spacing: number): [Vec2, Vec2][] {
  const segments: [Vec2, Vec2][] = [];
  for (const outline of outlines) for (let i = 0; i + 1 < outline.length; i++) segments.push([outline[i], outline[i + 1]]);
  if (!segments.length) return [];
  // Lines run along (1, 1); each is named by k in y - x = k.
  let low = Infinity;
  let high = -Infinity;
  for (const [a, b] of segments) for (const p of [a, b]) {
    low = Math.min(low, p[1] - p[0]);
    high = Math.max(high, p[1] - p[0]);
  }
  const step = spacing * Math.SQRT2;
  const lines: [Vec2, Vec2][] = [];
  for (let k = Math.ceil(low / step) * step + step / 2; k < high; k += step) {
    const hits: number[] = [];
    for (const [a, b] of segments) {
      const fa = a[1] - a[0] - k;
      const fb = b[1] - b[0] - k;
      if (fa > 0 === fb > 0) continue;
      const t = fa / (fa - fb);
      // Position along the line, as x + y.
      hits.push(a[0] + (b[0] - a[0]) * t + (a[1] + (b[1] - a[1]) * t));
    }
    hits.sort((p, q) => p - q);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      // x + y = s and y - x = k give x = (s - k) / 2, y = (s + k) / 2.
      lines.push([[(hits[i] - k) / 2, (hits[i] + k) / 2], [(hits[i + 1] - k) / 2, (hits[i + 1] + k) / 2]]);
    }
  }
  return lines;
}

/** Which of the view's two axes a world axis is along: 0 across, 1 up. Undefined when the view does not show the axis. */
export function viewAxis(view: ViewName, axis: 0 | 1 | 2): 0 | 1 | undefined {
  const table: Record<string, (0 | 1 | undefined)[]> = { front: [0, undefined, 1], top: [0, 1, undefined], right: [undefined, 0, 1], section: [undefined, undefined, undefined] };
  return table[view]?.[axis];
}

/** Which view shows a hole as a circle, which is the view looking along its axis. */
export function circleView(axis: 0 | 1 | 2): ViewName {
  return axis === 2 ? 'top' : axis === 1 ? 'front' : 'right';
}

/** The place of a hole in a view, in the view's own coordinates. */
export function holePlace(view: ViewName, hole: HoleData): Vec2 {
  const [h, v] = ([0, 1, 2] as const).filter((axis) => viewAxis(view, axis) !== undefined).sort((p, q) => viewAxis(view, p)! - viewAxis(view, q)!);
  return [hole.at[h], hole.at[v]];
}

export interface CalloutGroup {
  /** The first hole of the group, which the leader goes to. */
  hole: HoleData;
  count: number;
  lines: string[];
}

/** Holes that are alike are one callout with a count: `4X Ø3.4 THRU`. */
export function calloutGroups(holes: HoleData[]): CalloutGroup[] {
  const groups = new Map<string, CalloutGroup>();
  for (const hole of holes) {
    const key = [fmt(hole.diameter), hole.through, hole.through ? '' : fmt(hole.depth), hole.bore ? `${fmt(hole.bore.diameter)}/${fmt(hole.bore.depth)}` : ''].join('|');
    const group = groups.get(key);
    if (!group) groups.set(key, { hole, count: 1, lines: [] });
    else {
      group.count++;
      // The leader goes to the topmost hole of the group, so it does not run through the others.
      const place = (h: HoleData) => h.at[h.axis === 2 ? 1 : 2];
      if (place(hole) > place(group.hole)) group.hole = hole;
    }
  }
  for (const group of groups.values()) {
    const { hole } = group;
    const main = `Ø${fmt(hole.diameter)} ${hole.through ? 'THRU' : `DEEP ${fmt(hole.depth)}`}`;
    group.lines = [`${group.count > 1 ? `${group.count}X ` : ''}${main}`];
    if (hole.bore) group.lines.push(`CBORE Ø${fmt(hole.bore.diameter)} DEEP ${fmt(hole.bore.depth)}`);
  }
  return [...groups.values()];
}

/** How many rows of callouts a view needs above it, and how far apart the rows are. */
export const maxCalloutRows = 6;

export function calloutRows(groups: CalloutGroup[]) {
  const rows = Math.min(maxCalloutRows, groups.length);
  const stride = groups.some((group) => group.lines.length > 1) ? 11 : 7;
  return { rows, stride };
}

export interface PlacedFrame {
  name: ViewName;
  scale: number;
  /** The view's own coordinates of the lower left of its box, and where that lies on the sheet. */
  origin: Vec2;
  sheet: Vec2;
  box: ViewData['box'];
}

export const toSheet = (frame: PlacedFrame) => (p: Vec2): Vec2 => [frame.sheet[0] + (p[0] - frame.origin[0]) * frame.scale, frame.sheet[1] + (p[1] - frame.origin[1]) * frame.scale];

/** Where a section is cut in a view, so the callouts and ordinates keep clear of the marks that show it. */
export interface CutMark {
  /** True when the cutting line is horizontal in the view: its marks are at the left and right. */
  horizontal: boolean;
  /** The coordinate of the line across the view's other axis. */
  at: number;
}

/** The extra space a cutting line's marks take outside the view. */
export const cutReserve = 9;

/** Leaders and text for the holes of one view, in rows above it, each leader straight up from its hole. */
export function drawCallouts(paper: Paper, frame: PlacedFrame, groups: CalloutGroup[], cut?: CutMark): string[] {
  const map = toSheet(frame);
  const { stride } = calloutRows(groups);
  const top = map([0, frame.box[3]])[1] + (cut && !cut.horizontal ? cutReserve : 0);
  /** Where each callout went: its row, the x of its leader and the stretch its text covers. */
  const placed: { row: number; x: number; from: number; to: number }[] = [];
  const ordered = [...groups].sort((a, b) => holePlace(frame.name, a.hole)[0] - holePlace(frame.name, b.hole)[0]);
  /** The callouts that no row had room for, as the first line of each. */
  const unplaced: string[] = [];
  for (const group of ordered) {
    const centre = map(holePlace(frame.name, group.hole));
    const radius = (group.hole.diameter / 2) * frame.scale;
    const width = Math.max(...group.lines.map((line) => textWidth(line, style.textHeight)));
    const span = { from: centre[0] - width / 2 - 2, to: centre[0] + width / 2 + 2 };
    // The lowest row where the text touches no other text, no leader from a row above crosses it, and this leader crosses no text in the
    // rows below. When there is no such row, the leader may cross text, which is untidy but loses no callout.
    const free = (r: number, strict: boolean) => placed.every((other) => (
      other.row === r ? span.to <= other.from || span.from >= other.to
        : !strict ? true
          : other.row < r ? centre[0] < other.from || centre[0] > other.to
            : other.x < span.from || other.x > span.to
    ));
    const rowsToTry = Array.from({ length: maxCalloutRows }, (_, r) => r);
    const row = rowsToTry.find((r) => free(r, true)) ?? rowsToTry.find((r) => free(r, false));
    if (row === undefined) {
      unplaced.push(group.lines.join(', '));
      continue;
    }
    placed.push({ row, x: centre[0], from: span.from, to: span.to });
    const base = top + 4 + row * stride;
    // A hole on the cutting line would have its leader lie along the line's mark, so that leader slants away to the right.
    const onLine = cut && !cut.horizontal && Math.abs(holePlace(frame.name, group.hole)[0] - cut.at) < 0.005;
    if (onLine) {
      const start: Vec2 = [centre[0] + radius * Math.SQRT1_2, centre[1] + radius * Math.SQRT1_2];
      paper.line('DIM', start, [centre[0] + 9, base - 1]);
      paper.arrow(start, Math.atan2(-Math.SQRT1_2, -Math.SQRT1_2));
      group.lines.slice().reverse().forEach((line, i) => paper.text('DIM', [centre[0] + 9, base + i * 3.8], line, style.textHeight, 'start'));
      continue;
    }
    paper.line('DIM', [centre[0], centre[1] + radius], [centre[0], base - 1]);
    paper.arrow([centre[0], centre[1] + radius], -Math.PI / 2);
    group.lines.slice().reverse().forEach((line, i) => paper.text('DIM', [centre[0], base + i * 3.8], line, style.textHeight, 'middle'));
  }
  return unplaced;
}

/** Positions of holes from the lower left corner of a view, as ordinates along the bottom and the left. */
export function drawOrdinates(paper: Paper, frame: PlacedFrame, holes: HoleData[], cut?: CutMark): string[] {
  const map = toSheet(frame);
  const notes: string[] = [];
  const [x0, y0, x1, y1] = frame.box;
  const bottom = map([x0, y0])[1];
  const left = map([x0, y0])[0];
  const places = holes.map((hole) => ({ hole, place: holePlace(frame.name, hole) }));
  const unique = (values: number[], low: number, high: number) => {
    const found: number[] = [];
    for (const value of values) {
      if (value - low < 0.005 || high - value < 0.005) continue;
      if (!found.some((other) => Math.abs(other - value) < 0.005)) found.push(value);
    }
    return found.sort((a, b) => a - b);
  };
  const columns = unique(places.map((item) => item.place[0]), x0, x1);
  const rows = unique(places.map((item) => item.place[1]), y0, y1);
  const height = style.smallText;

  const across: { to: number }[][] = [[], []];
  for (const value of columns) {
    const x = map([value, y0])[0];
    const text = fmt(value - x0);
    const half = textWidth(text, height) / 2 + 1;
    const row = across.findIndex((list) => list.every((other) => Math.abs(other.to - x) >= half + 4.5));
    if (row < 0) {
      notes.push(`The position ${text} along the bottom of a view was left out because the labels would touch.`);
      continue;
    }
    across[row].push({ to: x });
    // The label on the cutting line moves out, past the marks.
    const end = bottom - 4 - (cut && !cut.horizontal && Math.abs(value - cut.at) < 0.005 ? cutReserve : 0);
    const source = places.find((item) => Math.abs(item.place[0] - value) < 0.005)!;
    paper.line('DIM', [x, map(source.place)[1] - (source.hole.diameter / 2) * frame.scale], [x, end]);
    paper.text('DIM', [x, end - 1 - height - row * 4], text, height, 'middle');
  }
  const down: { to: number }[][] = [[], []];
  for (const value of rows) {
    const y = map([x0, value])[1];
    const text = fmt(value - y0);
    const row = down.findIndex((list) => list.every((other) => Math.abs(other.to - y) >= 3.6));
    if (row < 0) {
      notes.push(`The position ${text} up the side of a view was left out because the labels would touch.`);
      continue;
    }
    down[row].push({ to: y });
    const end = left - 4 - (cut && cut.horizontal && Math.abs(value - cut.at) < 0.005 ? cutReserve - 2 : 0);
    const source = places.find((item) => Math.abs(item.place[1] - value) < 0.005)!;
    paper.line('DIM', [map(source.place)[0] - (source.hole.diameter / 2) * frame.scale, y], [end, y]);
    paper.text('DIM', [end - 1 - row * 10, y - height / 2], text, height, 'end');
  }
  // The 0 at the corner is left off when the first position is so near it that the two labels would touch.
  if (columns.length && across.every((list) => list.every((other) => Math.abs(other.to - left) > 6.5))) paper.text('DIM', [left, bottom - 4 - 1 - height], '0', height, 'middle');
  if (rows.length && down.every((list) => list.every((other) => Math.abs(other.to - bottom) > 3.8))) paper.text('DIM', [left - 5, bottom - height / 2], '0', height, 'end');
  return notes;
}

/** The overall width and height of a view's box, each on the sheet side that the layout reserved. */
export function drawOverall(paper: Paper, frame: PlacedFrame, width: boolean, height: boolean, lane: { bottom: number; right: number }) {
  const map = toSheet(frame);
  const [x0, y0, x1, y1] = frame.box;
  if (width) linearDimension(paper, map([x0, y0]), map([x1, y0]), [0, -1], lane.bottom, fmt(x1 - x0));
  if (height) linearDimension(paper, map([x1, y0]), map([x1, y1]), [1, 0], lane.right, fmt(y1 - y0));
}

/** The diameters of a turned part and the lengths of its steps, in the view that holds the axis. */
export function drawTurned(paper: Paper, frame: PlacedFrame, turned: TurnedData): { right: number; top: number } {
  const map = toSheet(frame);
  const axial = viewAxis(frame.name, turned.axis);
  const [p, q] = turned.axis === 0 ? [1, 2] : turned.axis === 1 ? [0, 2] : [0, 1];
  const perpendicular = [p, q].map((axis) => ({ axis: axis as 0 | 1 | 2, place: viewAxis(frame.name, axis as 0 | 1 | 2) })).find((item) => item.place !== undefined);
  if (axial === undefined || !perpendicular) return { right: 0, top: 0 };
  const centre = turned.at[perpendicular.axis === p ? 0 : 1];
  const diameters = [...new Set(turned.steps.map((step) => Math.round(step.diameter * 1000) / 1000))].sort((a, b) => b - a);
  const put = (along: number, across: number): Vec2 => (axial === 0 ? [along, across] : [across, along]);
  let lane = 0;
  for (const diameter of diameters) {
    const step = turned.steps.find((item) => Math.abs(item.diameter - diameter) < 1e-3)!;
    const middle = (step.from + step.to) / 2;
    const a = map(put(middle, centre - diameter / 2));
    const b = map(put(middle, centre + diameter / 2));
    lane += 1;
    // A shaft lying across the view has its diameters on the right; one standing up has them above.
    if (axial === 0) linearDimension(paper, a, b, [1, 0], (frame.box[2] - middle) * frame.scale + 4 + lane * 9, `Ø${fmt(diameter)}`);
    else linearDimension(paper, a, b, [0, 1], (frame.box[3] - (centre + diameter / 2)) * frame.scale + 4 + lane * 9, `Ø${fmt(diameter)}`);
  }
  // The length of each step, along the bottom or the right side.
  if (turned.steps.length > 1) {
    for (const step of turned.steps) {
      const a = map(axial === 0 ? [step.from, frame.box[1]] : [frame.box[0], step.from]);
      const b = map(axial === 0 ? [step.to, frame.box[1]] : [frame.box[0], step.to]);
      linearDimension(paper, a, b, axial === 0 ? [0, -1] : [-1, 0], 9, fmt(step.to - step.from));
    }
  }
  return axial === 0 ? { right: lane * 9 + 4, top: 0 } : { right: 0, top: lane * 9 + 4 };
}

/** The line that marks where a section is cut, in the view that shows the hole as a circle, with arrows for the way the viewer looks and the letter at each end. */
export function drawCuttingLine(paper: Paper, frame: PlacedFrame, axis: 0 | 1 | 2, at: number, looking: 1 | -1, label: string) {
  const map = toSheet(frame);
  const place = viewAxis(frame.name, axis);
  if (place === undefined) return;
  const [x0, y0, x1, y1] = frame.box;
  const run = place === 1 ? [x0, x1] : [y0, y1];
  const piece = 4;
  const gap = 2;
  const put = (along: number, across: number): Vec2 => (place === 1 ? map([along, across]) : map([across, along]));
  const direction: Vec2 = place === 1 ? [0, looking] : [looking, 0];
  for (const [side, edge] of [[-1, run[0]], [1, run[1]]] as const) {
    const inner = put(edge, at);
    const outerAlong = side * (piece + gap);
    const startAlong = side * gap;
    const move = (distance: number): Vec2 => (place === 1 ? [inner[0] + distance, inner[1]] : [inner[0], inner[1] + distance]);
    paper.line('OUTLINE', move(startAlong), move(outerAlong));
    const outer = move(outerAlong);
    const tip = add(outer, mul(direction, 5));
    paper.line('OUTLINE', outer, tip);
    paper.arrow(tip, Math.atan2(direction[1], direction[0]));
    paper.text('TEXT', add(tip, mul(direction, 4)), label, 4, 'middle');
  }
}

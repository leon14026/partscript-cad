import { textWidth } from './font.ts';
import {
  Paper, calloutGroups, calloutRows, circleView, cutReserve, drawCallouts, drawCuttingLine, drawOrdinates, drawOverall, drawTurned, fmt, hatchLines, style, toSheet, viewAxis,
  type CutMark, type PlacedFrame,
} from './dimensions.ts';
import { borderMargin, chooseViews, drawingArea, placeViews, scaleSteps, scaleText, sheetSizes, titleBlock, type ViewRequest } from './layout.ts';
import type { AssemblyDrawing, DrawingOptions, DrawingResult, HoleData, PartDrawing, Sheet, SheetSize, Vec2, ViewData, ViewName } from './types.ts';

/** A view with more hidden curves than this has its hidden lines off unless the person turns them on: the dashes would bury the part. */
export const hiddenLineLimit = 150;

export interface SheetContext {
  /** For a hole that `$fn` made a flat-sided prism: what to tell the person, which should say where `$fn` is set. */
  polygonNote?(part: PartDrawing, hole: HoleData): string | undefined;
}

export const generalNote = 'DIMENSIONS IN MM. TOLERANCES NOT SPECIFIED.';

export function defaultOptions(): DrawingOptions {
  return { size: 'ansi-a', projection: 'third', hidden: 'auto', title: { drawnBy: '', date: '', revision: 'A', material: '' } };
}

function showHidden(view: ViewData, part: PartDrawing, options: DrawingOptions) {
  if (!view.hidden.length) return false;
  if (options.hidden === 'on') return true;
  if (options.hidden === 'off') return false;
  // An isometric is read for its shape, and dashes behind the part would only confuse it.
  return view.name !== 'iso' && part.quality === 'exact' && !part.imported && view.hidden.length <= hiddenLineLimit;
}

/** The view that carries the diameters of a turned part: one that shows the axis, lying across the sheet where it can. */
function turnedViewOf(part: PartDrawing, names: ViewName[]): ViewName | undefined {
  if (!part.turned) return undefined;
  const order: ViewName[] = part.turned.axis === 0 ? ['front', 'top'] : part.turned.axis === 1 ? ['right', 'top'] : ['front', 'right'];
  return order.find((name) => names.includes(name));
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function border(paper: Paper, size: SheetSize) {
  const { width, height } = sheetSizes[size];
  const m = borderMargin;
  paper.poly('BORDER', [[m, m], [width - m, m], [width - m, height - m], [m, height - m]], true);
}

/** The projection symbol: a truncated cone and its end view, which stand on the side the end view is drawn. */
function projectionSymbol(paper: Paper, x: number, y: number, projection: DrawingOptions['projection']) {
  const cone = projection === 'third' ? 9 : 0;
  const circles = projection === 'third' ? 0 : 12;
  paper.poly('OUTLINE', [[x + cone, y + 2], [x + cone + 8, y], [x + cone + 8, y + 7], [x + cone, y + 5]], true);
  paper.circle('OUTLINE', [x + circles + 3.5, y + 3.5], 3.4);
  paper.circle('OUTLINE', [x + circles + 3.5, y + 3.5], 1.7);
}

function titleBlockEntities(paper: Paper, part: { names: string[]; quantity: number }, options: DrawingOptions, scale: string) {
  const sheet = sheetSizes[options.size];
  const x1 = sheet.width - borderMargin;
  const y0 = borderMargin;
  const x0 = x1 - titleBlock.width;
  const y1 = y0 + titleBlock.height;
  paper.poly('BORDER', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
  paper.line('BORDER', [x0, y0 + 13], [x1, y0 + 13]);
  paper.line('BORDER', [x0, y0 + 26], [x1, y0 + 26]);
  const label = (x: number, y: number, text: string) => paper.text('TEXT', [x + 1.5, y - 3.2], text, 2, 'start');
  const value = (x: number, y: number, text: string, height = 3.5) => paper.text('TEXT', [x + 1.5, y + 3], text, height, 'start');

  // The name of the part, and how many are wanted.
  const quantity = part.quantity > 1 ? `  QTY ${part.quantity}` : '';
  const name = part.names.join(', ') + quantity;
  label(x0, y1, 'PART');
  const fit = Math.max(2.5, Math.min(5, (titleBlock.width - 6) / Math.max(textWidth(name, 1), 1)));
  value(x0, y0 + 26, name, fit);

  const rowB = [0, 30, 60, 105, 130];
  const cellsB: [string, string][] = [['SCALE', scale], ['SHEET', sheetSizes[options.size].label], ['PROJECTION', options.projection === 'third' ? 'THIRD ANGLE' : 'FIRST ANGLE'], ['UNITS', 'MM']];
  cellsB.forEach(([name2, text], i) => {
    if (i > 0) paper.line('BORDER', [x0 + rowB[i], y0 + 13], [x0 + rowB[i], y0 + 26]);
    label(x0 + rowB[i], y0 + 26, name2);
    value(x0 + rowB[i], y0 + 13, text, name2 === 'PROJECTION' ? 2.5 : 3.5);
  });
  projectionSymbol(paper, x0 + rowB[3] - 22, y0 + 15.5, options.projection);

  const rowC = [0, 40, 70, 85, 130];
  const { title } = options;
  const cellsC: [string, string][] = [['DRAWN BY', title.drawnBy], ['DATE', title.date], ['REV', title.revision], ['MATERIAL', title.material]];
  cellsC.forEach(([name2, text], i) => {
    if (i > 0) paper.line('BORDER', [x0 + rowC[i], y0], [x0 + rowC[i], y0 + 13]);
    label(x0 + rowC[i], y0 + 13, name2);
    const width = rowC[i + 1] - rowC[i] - 3;
    value(x0 + rowC[i], y0, text, Math.min(3.5, Math.max(2, (width / Math.max(textWidth(text, 1), 1)))));
  });
}

/** The sheet of one part. */
export function buildSheet(part: PartDrawing, options: DrawingOptions, context: SheetContext = {}): Sheet {
  const notes = [...part.notes];
  const names = chooseViews(part);
  const sheet = sheetSizes[options.size];
  const named = new Map(part.views.map((view) => [view.name, view]));
  const shown: ViewData[] = names.map((name) => named.get(name)!).filter(Boolean);

  let holes = part.holes;
  if (part.imported) {
    const small = holes.filter((hole) => hole.diameter <= 4);
    if (small.length) notes.push(`${plural(small.length, 'hole', 'holes')} of Ø4 or less on an imported part ${small.length === 1 ? 'is' : 'are'} drawn but not dimensioned.`);
    holes = holes.filter((hole) => hole.diameter > 4);
  }
  const holesOf = new Map<ViewName, HoleData[]>();
  let unseen = 0;
  for (const hole of holes) {
    const view = circleView(hole.axis);
    if (names.includes(view)) holesOf.set(view, [...(holesOf.get(view) ?? []), hole]);
    else unseen++;
  }
  if (unseen) notes.push(`${plural(unseen, 'hole', 'holes')} cannot be seen square-on in the views drawn, so ${unseen === 1 ? 'it is' : 'they are'} not dimensioned.`);
  for (const hole of holes) if (hole.sides) {
    notes.push(context.polygonNote?.(part, hole) ?? `A hole of Ø${fmt(hole.diameter)} is a ${hole.sides}-sided polygon in this model, so its diameter is read over the corners. Delete $fn for a true round hole.`);
  }

  let section = part.section;
  if (section && !names.includes(section.lineIn)) {
    notes.push('A section through a blind or stepped hole was not drawn, because the view that would carry its cutting line is not on this sheet.');
    section = undefined;
  }

  // Which view carries each overall size: the first that shows the axis.
  const overall = new Map<ViewName, { width: boolean; height: boolean }>();
  const turnedView = turnedViewOf(part, names);
  for (const axis of [0, 1, 2] as const) {
    if (part.turned && axis !== part.turned.axis && turnedView) continue;
    const order: ViewName[] = axis === 0 ? ['front', 'top'] : axis === 1 ? ['top', 'right'] : ['front', 'right'];
    const view = order.find((name) => names.includes(name));
    if (!view) continue;
    const place = viewAxis(view, axis);
    const entry = overall.get(view) ?? { width: false, height: false };
    if (place === 0) entry.width = true;
    else entry.height = true;
    overall.set(view, entry);
  }

  const diameters = part.turned ? new Set(part.turned.steps.map((step) => Math.round(step.diameter * 1000))).size : 0;
  const turnedAcross = turnedView && part.turned ? viewAxis(turnedView, part.turned.axis) === 0 : false;
  /** For the view that carries the cutting line: which way it runs and where. */
  const cutOf = (name: ViewName): CutMark | undefined => {
    if (!section || name !== section.lineIn) return undefined;
    const place = viewAxis(name, section.axis);
    return place === undefined ? undefined : { horizontal: place === 1, at: section.at };
  };
  const requests: ViewRequest[] = shown.map((view) => {
    const groups = calloutGroups(holesOf.get(view.name) ?? []);
    const { rows, stride } = calloutRows(groups);
    const turned = view.name === turnedView ? diameters * 9 + 4 : 0;
    const cut = cutOf(view.name);
    return {
      view,
      top: rows * stride + (turned && !turnedAcross ? turned : 0) + (cut && !cut.horizontal ? cutReserve : 0),
      right: (turned && turnedAcross ? turned : 0) + (cut?.horizontal ? cutReserve : 0),
      bottom: cut && !cut.horizontal ? cutReserve : 0,
    };
  });
  if (section) requests.push({ view: section.view });
  const longest = Math.max(...[0, 1, 2].map((i) => part.bounds.max[i] - part.bounds.min[i]));
  const layout = placeViews(requests, options.projection, options.size, longest < 20);
  if (!layout.fits) notes.push('The part is too large for this sheet even at the smallest scale. Choose a larger sheet.');

  const paper = new Paper();
  border(paper, options.size);
  const frames = new Map<ViewName, PlacedFrame>();
  for (const placed of layout.views) {
    frames.set(placed.view.name, { name: placed.view.name, scale: placed.scale, origin: [placed.view.box[0], placed.view.box[1]], sheet: [placed.x, placed.y], box: placed.view.box });
  }

  for (const placed of layout.views) {
    const { view } = placed;
    const frame = frames.get(view.name)!;
    const map = toSheet(frame);
    for (const curve of view.visible) paper.curve('OUTLINE', curve, map, frame.scale);
    if (showHidden(view, part, options)) for (const curve of view.hidden) paper.curve('HIDDEN', curve, map, frame.scale);
    const centre = map([(view.box[0] + view.box[2]) / 2, view.box[1]])[0];
    if (view.name === 'iso') {
      paper.text('TEXT', [centre, frame.sheet[1] - 6], `ISOMETRIC${frame.scale === layout.scale ? '' : ` ${scaleText(frame.scale)}`}`, 3, 'middle');
      continue;
    }
    if (view.name === 'section' && section) {
      const outlines = section.outlines.map((outline) => outline.map(map));
      for (const [a, b] of hatchLines(outlines, style.hatchSpacing)) paper.line('HATCH', a, b);
      paper.text('TEXT', [centre, frame.sheet[1] - 8], `SECTION ${section.label}-${section.label}`, 4, 'middle');
      continue;
    }
    const flags = overall.get(view.name);
    const cut = cutOf(view.name);
    if (flags) drawOverall(paper, frame, flags.width, flags.height, { bottom: 17 + (cut && !cut.horizontal ? cutReserve : 0), right: 10 + (cut?.horizontal ? cutReserve : 0) });
    const own = holesOf.get(view.name) ?? [];
    if (own.length) {
      const unplaced = drawCallouts(paper, frame, calloutGroups(own), cut);
      if (unplaced.length) notes.push(`${plural(unplaced.length, 'hole callout', 'hole callouts')} did not fit above the ${view.name} view and ${unplaced.length === 1 ? 'is' : 'are'} not drawn: ${unplaced.join('; ')}.`);
      notes.push(...drawOrdinates(paper, frame, own, cut));
    }
    if (part.turned && view.name === turnedView) drawTurned(paper, frame, part.turned);
    if (section && view.name === section.lineIn) drawCuttingLine(paper, frame, section.axis, section.at, section.looking, section.label);
  }

  paper.text('TEXT', [borderMargin + 3, borderMargin + 3], generalNote, 2.5, 'start');
  titleBlockEntities(paper, part, options, scaleText(layout.scale));
  const file = part.names[0].replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';
  return { name: file, width: sheet.width, height: sheet.height, entities: paper.entities, scale: scaleText(layout.scale), notes };
}

/** Columns of the parts list on the assembly sheet, in millimetres from its left edge. The list is as wide as the title block. */
const listColumns = [0, 14, 28, 80, 130];
const listRow = 6;

/** The text cut short, with dots, until it is at most `width` wide. */
function fitText(text: string, height: number, width: number) {
  if (textWidth(text, height) <= width) return text;
  let cut = text;
  while (cut.length > 1 && textWidth(`${cut}...`, height) > width) cut = cut.slice(0, -1);
  return `${cut}...`;
}

/**
 * The sheet of a whole assembly: its isometric view in the pose shown, a numbered balloon on each part with a leader to a point of the
 * part that the view shows, and the parts list above the title block.
 */
export function buildAssemblySheet(assembly: AssemblyDrawing, options: DrawingOptions): Sheet {
  const sheet = sheetSizes[options.size];
  const paper = new Paper();
  const notes = [...assembly.notes];
  border(paper, options.size);

  // The parts list, from the top of the title block upward, with its header on top. A list too long for the sheet is cut, and the sheet says so.
  const area = drawingArea(options.size);
  const listLeft = sheet.width - borderMargin - titleBlock.width;
  const listBottom = borderMargin + titleBlock.height;
  const fitRows = Math.max(1, Math.floor((area.top - listBottom - 40) / listRow) - 1);
  const shown = assembly.items.slice(0, fitRows);
  if (shown.length < assembly.items.length) notes.push(`${plural(assembly.items.length - shown.length, 'item', 'items')} could not fit in the parts list. Choose a larger sheet.`);
  const listTop = listBottom + (shown.length + 1) * listRow;
  paper.poly('BORDER', [[listLeft, listBottom], [listLeft + titleBlock.width, listBottom], [listLeft + titleBlock.width, listTop], [listLeft, listTop]], true);
  for (let row = 1; row <= shown.length; row++) paper.line('BORDER', [listLeft, listBottom + row * listRow], [listLeft + titleBlock.width, listBottom + row * listRow]);
  for (const column of listColumns.slice(1, -1)) paper.line('BORDER', [listLeft + column, listBottom], [listLeft + column, listTop]);
  const cell = (column: number, row: number, text: string, height: number) => {
    const width = listColumns[column + 1] - listColumns[column] - 3;
    paper.text('TEXT', [listLeft + listColumns[column] + 1.5, listBottom + row * listRow + 1.8], fitText(text, height, width), height, 'start');
  };
  ['ITEM', 'QTY', 'PART', 'SIZE (MM)'].forEach((heading, column) => cell(column, shown.length, heading, 2.5));
  shown.forEach((entry, i) => {
    const row = shown.length - 1 - i;
    cell(0, row, String(entry.item), 3.2);
    cell(1, row, String(entry.quantity), 3.2);
    cell(2, row, entry.name, 3.2);
    cell(3, row, entry.size.map(fmt).join(' × '), 3.2);
  });

  // The view goes at the largest scale that fits, with room for a ring of balloons around it, in the better of two places: above the
  // list, or beside it.
  const ring = 14;
  const [w, h] = [assembly.view.box[2] - assembly.view.box[0], assembly.view.box[3] - assembly.view.box[1]];
  const regions = [
    { left: area.left, bottom: listTop + 5, right: area.right, top: area.top },
    { left: area.left, bottom: borderMargin + 12, right: listLeft - 5, top: area.top },
  ];
  let place: { region: (typeof regions)[number]; scale: number } | undefined;
  for (const region of regions) {
    const scale = scaleSteps.filter((step) => step <= 1).find((step) => w * step + 2 * ring <= region.right - region.left && h * step + 2 * ring <= region.top - region.bottom);
    if (scale !== undefined && (!place || scale > place.scale)) place = { region, scale };
  }
  const scale = place?.scale ?? scaleSteps[scaleSteps.length - 1];
  const region = place?.region ?? regions[0];
  if (!place) notes.push('The assembly is too large for this sheet even at the smallest scale. Choose a larger sheet.');
  const frame: PlacedFrame = {
    name: 'iso', scale, origin: [assembly.view.box[0], assembly.view.box[1]],
    sheet: [(region.left + region.right - w * scale) / 2, (region.bottom + region.top - h * scale) / 2], box: assembly.view.box,
  };
  const map = toSheet(frame);
  for (const curve of assembly.view.visible) paper.curve('OUTLINE', curve, map, scale);

  // Balloons sit on a rectangle around the view, in the order their leaders leave the view's middle, kept apart along it.
  const around: [number, number, number, number] = [frame.sheet[0] - ring + 4, frame.sheet[1] - ring + 4, frame.sheet[0] + w * scale + ring - 4, frame.sheet[1] + h * scale + ring - 4];
  const [rw, rh] = [around[2] - around[0], around[3] - around[1]];
  const perimeter = 2 * (rw + rh);
  const centre: Vec2 = [(around[0] + around[2]) / 2, (around[1] + around[3]) / 2];
  /** The distance along the rectangle, clockwise from its upper left corner, of the point where a ray from the middle leaves it. */
  const along = (direction: Vec2) => {
    const t = Math.min(direction[0] ? Math.abs(rw / 2 / direction[0]) : Infinity, direction[1] ? Math.abs(rh / 2 / direction[1]) : Infinity);
    const [x, y] = [direction[0] * t, direction[1] * t];
    if (Math.abs(y - rh / 2) < 1e-9) return rw + rh + (rw / 2 - x);
    if (Math.abs(y + rh / 2) < 1e-9) return rw / 2 + x;
    if (Math.abs(x - rw / 2) < 1e-9) return rw + (rh / 2 - y);
    return 2 * rw + rh + (y + rh / 2);
  };
  const onRing = (distance: number): Vec2 => {
    const d = ((distance % perimeter) + perimeter) % perimeter;
    if (d <= rw) return [around[0] + d, around[3]];
    if (d <= rw + rh) return [around[2], around[3] - (d - rw)];
    if (d <= 2 * rw + rh) return [around[2] - (d - rw - rh), around[1]];
    return [around[0], around[1] + (d - 2 * rw - rh)];
  };
  const anchors = assembly.balloons.map((balloon) => map(balloon.point));
  const order = anchors.map((anchor, i) => ({ i, s: along([anchor[0] - centre[0] || 1e-6, anchor[1] - centre[1]]) })).sort((a, b) => a.s - b.s);
  const gap = 10;
  for (let k = 1; k < order.length; k++) order[k].s = Math.max(order[k].s, order[k - 1].s + gap);
  const overflow = order.length ? order[order.length - 1].s - order[0].s - (perimeter - gap) : 0;
  if (overflow > 0) notes.push('There are too many balloons to keep clear of one another around this view.');
  for (const { i, s } of order) {
    const at = onRing(s);
    const balloon = assembly.balloons[i];
    const toward: Vec2 = [anchors[i][0] - at[0], anchors[i][1] - at[1]];
    const length = Math.hypot(toward[0], toward[1]) || 1;
    const start: Vec2 = [at[0] + (toward[0] / length) * 4, at[1] + (toward[1] / length) * 4];
    // A part that no pixel of the view shows has a dashed leader to its middle.
    paper.line(balloon.hidden ? 'HIDDEN' : 'DIM', start, anchors[i]);
    if (!balloon.hidden) paper.circle('OUTLINE', anchors[i], 0.3);
    paper.circle('DIM', at, 4);
    paper.text('TEXT', [at[0], at[1] - 1.25], String(balloon.item), 3.5, 'middle');
  }

  paper.text('TEXT', [borderMargin + 3, borderMargin + 3], generalNote, 2.5, 'start');
  titleBlockEntities(paper, { names: [`${assembly.name} ASSEMBLY`], quantity: 1 }, options, scaleText(scale));
  const file = `${assembly.name}_assembly`.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'assembly';
  return { name: file, width: sheet.width, height: sheet.height, entities: paper.entities, scale: scaleText(scale), notes };
}

/** The assembly sheet when the model has one, then one sheet for each distinct part. */
export function buildSheets(drawing: DrawingResult, options: DrawingOptions, context: SheetContext = {}): Sheet[] {
  const parts = drawing.parts.map((part) => buildSheet(part, options, context));
  return drawing.assembly ? [buildAssemblySheet(drawing.assembly, options), ...parts] : parts;
}

import type { PartDrawing, Projection, SheetSize, ViewData, ViewName } from './types.ts';

export const sheetSizes: Record<SheetSize, { label: string; width: number; height: number }> = {
  'ansi-a': { label: 'ANSI A', width: 279.4, height: 215.9 },
  a4: { label: 'A4', width: 297, height: 210 },
  a3: { label: 'A3', width: 420, height: 297 },
  'ansi-b': { label: 'ANSI B', width: 431.8, height: 279.4 },
};

/** The border sits this far in from the edge of the paper. */
export const borderMargin = 10;
/** The title block's size, in the lower right corner inside the border. */
export const titleBlock = { width: 130, height: 40 };
/** Space kept between the border or the title block and the views. */
const edgeGap = 5;

/** Scales as factors of the true size, from the largest to the smallest. */
export const scaleSteps = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50];

export function scaleText(scale: number) {
  return scale >= 1 ? `${scale}:1` : `1:${Math.round(1 / scale)}`;
}

/** Fixed space around a view that carries dimensions, in millimetres of paper. */
export const padding = { left: 22, right: 14, bottom: 22, top: 9 };
/** Each row of callouts above a view needs this much more. */
export const calloutRow = 7;

/** The sorted sides of a part: a plate has one thin side, under 15% of its longest, and two that are not. */
export function plateAxis(part: PartDrawing): 0 | 1 | 2 | undefined {
  const size = [0, 1, 2].map((i) => part.bounds.max[i] - part.bounds.min[i]);
  const order = [0, 1, 2].sort((a, b) => size[a] - size[b]) as (0 | 1 | 2)[];
  const longest = size[order[2]];
  if (longest > 0 && size[order[0]] < 0.15 * longest && size[order[1]] >= 0.15 * longest) return order[0];
  return undefined;
}

/** The views a part gets, in the order of the grid. A plate has the face and one edge; anything else the three principal views and an isometric. */
export function chooseViews(part: PartDrawing): ViewName[] {
  const thin = plateAxis(part);
  if (thin === 2) return ['top', 'front'];
  if (thin === 1) return ['front', 'top'];
  if (thin === 0) return ['right', 'front'];
  return ['front', 'top', 'right', 'iso'];
}

/** Column and row, counted from the top left of the drawing, of each view in a projection. */
function cellOf(name: ViewName, projection: Projection): [number, number] {
  if (projection === 'third') return { top: [0, 0], front: [0, 1], right: [1, 1], iso: [1, 0], section: [2, 0] }[name] as [number, number];
  return { right: [0, 0], front: [1, 0], top: [1, 1], iso: [0, 1], section: [2, 0] }[name] as [number, number];
}

export interface PlacedView {
  view: ViewData;
  /** The scale this view is drawn at. */
  scale: number;
  /** Where the lower left of the view's box lies on the sheet. */
  x: number;
  y: number;
  /** The space around the view that its dimensions use. */
  pad: { left: number; right: number; bottom: number; top: number };
}

export interface Layout {
  scale: number;
  views: PlacedView[];
  /** False when even the smallest scale did not fit. */
  fits: boolean;
}

/** The area inside the border and above the title block where views may go. */
export function drawingArea(size: SheetSize) {
  const sheet = sheetSizes[size];
  const left = borderMargin + edgeGap;
  const bottom = borderMargin + titleBlock.height + edgeGap;
  return { left, bottom, right: sheet.width - borderMargin - edgeGap, top: sheet.height - borderMargin - edgeGap };
}

export interface ViewRequest {
  view: ViewData;
  /** Extra space above this view for rows of callouts and the like. */
  top?: number;
  right?: number;
  bottom?: number;
}

/**
 * Put the views on the sheet at the largest scale that fits. The scale starts at 1:1 and goes down, because a part that fits at full size
 * is drawn at full size. A part whose longest side is under 20 mm is the exception: it starts at the largest step, 10:1.
 */
export function placeViews(requests: ViewRequest[], projection: Projection, size: SheetSize, smallPart: boolean): Layout {
  const area = drawingArea(size);
  const grid = requests.filter((request) => request.view.name !== 'iso');
  const iso = requests.find((request) => request.view.name === 'iso');
  const cells = grid.map((request) => ({ request, cell: cellOf(request.view.name, projection) }));
  const columns = [...new Set(cells.map((item) => item.cell[0]))].sort((a, b) => a - b);
  const rows = [...new Set(cells.map((item) => item.cell[1]))].sort((a, b) => a - b);
  const pads = (item: (typeof cells)[number]) => ({ left: padding.left, right: padding.right + (item.request.right ?? 0), bottom: padding.bottom + (item.request.bottom ?? 0), top: padding.top + (item.request.top ?? 0) });

  const attempt = (scale: number) => {
    const columnWidth = columns.map((column) => Math.max(0, ...cells.filter((item) => item.cell[0] === column).map((item) => pads(item).left + (item.request.view.box[2] - item.request.view.box[0]) * scale + pads(item).right)));
    const rowHeight = rows.map((row) => Math.max(0, ...cells.filter((item) => item.cell[1] === row).map((item) => pads(item).top + (item.request.view.box[3] - item.request.view.box[1]) * scale + pads(item).bottom)));
    const total = [columnWidth.reduce((a, b) => a + b, 0), rowHeight.reduce((a, b) => a + b, 0)];
    return { columnWidth, rowHeight, total, ok: total[0] <= area.right - area.left && total[1] <= area.top - area.bottom };
  };

  const start = smallPart ? 0 : scaleSteps.indexOf(1);
  let chosen = scaleSteps[scaleSteps.length - 1];
  let fits = false;
  for (let i = start; i < scaleSteps.length; i++) {
    if (attempt(scaleSteps[i]).ok) {
      chosen = scaleSteps[i];
      fits = true;
      break;
    }
  }
  const { columnWidth, rowHeight, total } = attempt(chosen);
  const originX = area.left + Math.max(0, (area.right - area.left - total[0]) / 2);
  // Rows count from the top, but the sheet's y grows upward, so the first row starts at the top of the group.
  const groupTop = area.top - Math.max(0, (area.top - area.bottom - total[1]) / 2);
  const views: PlacedView[] = [];
  for (const item of cells) {
    const column = columns.indexOf(item.cell[0]);
    const row = rows.indexOf(item.cell[1]);
    const cellLeft = originX + columnWidth.slice(0, column).reduce((a, b) => a + b, 0);
    const cellTop = groupTop - rowHeight.slice(0, row).reduce((a, b) => a + b, 0);
    const pad = pads(item);
    const columnPad = Math.max(...cells.filter((other) => other.cell[0] === item.cell[0]).map((other) => pads(other).left));
    const rowPad = Math.max(...cells.filter((other) => other.cell[1] === item.cell[1]).map((other) => pads(other).bottom));
    const height = (item.request.view.box[3] - item.request.view.box[1]) * chosen;
    const rowTopPad = Math.max(...cells.filter((other) => other.cell[1] === item.cell[1]).map((other) => pads(other).top));
    const width = (item.request.view.box[2] - item.request.view.box[0]) * chosen;
    // A view is centred in its cell across, so views that share an extent line up.
    const columnInner = columnWidth[column] - columnPad - Math.max(...cells.filter((other) => other.cell[0] === item.cell[0]).map((other) => pads(other).right));
    const rowInner = rowHeight[row] - rowTopPad - rowPad;
    views.push({
      view: item.request.view,
      scale: chosen,
      x: cellLeft + columnPad + (columnInner - width) / 2,
      y: cellTop - rowTopPad - (rowInner - height) / 2 - height,
      pad,
    });
  }

  // The isometric goes in the free cell next to the top view (third angle) or below the right view (first angle), at its own scale.
  if (iso && cells.length) {
    const cell = cellOf('iso', projection);
    const column = columns.indexOf(cell[0]);
    const row = rows.indexOf(cell[1]);
    const taken = cells.some((item) => item.cell[0] === cell[0] && item.cell[1] === cell[1]);
    if (!taken && column >= 0 && row >= 0) {
      const neighbourColumn = columns.includes(cell[0] + 1);
      const regionLeft = originX + columnWidth.slice(0, column).reduce((a, b) => a + b, 0);
      const regionWidth = neighbourColumn ? columnWidth[column] : area.right - regionLeft;
      const regionTop = groupTop - rowHeight.slice(0, row).reduce((a, b) => a + b, 0);
      const regionHeight = rowHeight[row];
      const w = iso.view.box[2] - iso.view.box[0];
      const h = iso.view.box[3] - iso.view.box[1];
      const label = 9;
      for (const scale of scaleSteps.filter((s) => s <= chosen)) {
        if (w * scale + 6 <= regionWidth && h * scale + label + 6 <= regionHeight && scale >= 1 / 10) {
          views.push({
            view: iso.view,
            scale,
            x: regionLeft + (regionWidth - w * scale) / 2,
            y: regionTop - (regionHeight - label - h * scale) / 2 - h * scale,
            pad: { left: 0, right: 0, bottom: label, top: 0 },
          });
          break;
        }
      }
    }
  }
  return { scale: chosen, views, fits };
}

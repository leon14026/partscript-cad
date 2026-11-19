import { sheetSizes } from './layout.ts';
import { defaultOptions } from './sheet.ts';
import type { DrawingOptions, Projection, SheetSize } from './types.ts';

/** The longest any title block field can be. The block has room for about this many capitals. */
export const titleFieldLimit = 40;

const projections: Projection[] = ['third', 'first'];
const hiddenChoices: DrawingOptions['hidden'][] = ['auto', 'on', 'off'];

/**
 * Drawing settings read from a saved project or a draft. Anything that is not a valid setting falls back to its default,
 * so a file edited by hand, or one from a later version, still opens.
 */
export function readDrawingOptions(value: unknown): DrawingOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  const fallback = defaultOptions();
  const title = (data.title && typeof data.title === 'object' ? data.title : {}) as Record<string, unknown>;
  const text = (item: unknown, other: string) => (typeof item === 'string' ? item.slice(0, titleFieldLimit) : other);
  return {
    size: typeof data.size === 'string' && data.size in sheetSizes ? data.size as SheetSize : fallback.size,
    projection: projections.find((item) => item === data.projection) ?? fallback.projection,
    hidden: hiddenChoices.find((item) => item === data.hidden) ?? fallback.hidden,
    title: {
      drawnBy: text(title.drawnBy, fallback.title.drawnBy),
      date: text(title.date, fallback.title.date),
      revision: text(title.revision, fallback.title.revision),
      material: text(title.material, fallback.title.material),
    },
  };
}

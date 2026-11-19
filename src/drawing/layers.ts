import type { Layer } from './types.ts';

/** How each layer is drawn. Line weights are in millimetres; the writers share this table so a sheet looks the same in all three formats. */
export const layerStyles: Record<Layer, { weight: number; dash?: [number, number] }> = {
  OUTLINE: { weight: 0.5 },
  HIDDEN: { weight: 0.25, dash: [3, 1.5] },
  DIM: { weight: 0.18 },
  HATCH: { weight: 0.15 },
  TEXT: { weight: 0.18 },
  BORDER: { weight: 0.5 },
};

export const layerOrder: Layer[] = ['BORDER', 'HATCH', 'HIDDEN', 'OUTLINE', 'DIM', 'TEXT'];

/** The three corners of a filled arrowhead, whose tip is at `tip` and which points in `angle`. */
export function arrowPoints(tip: [number, number], angle: number): [number, number][] {
  const length = 3;
  const half = 0.55;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const base: [number, number] = [tip[0] - c * length, tip[1] - s * length];
  return [tip, [base[0] - s * half, base[1] + c * half], [base[0] + s * half, base[1] - c * half]];
}

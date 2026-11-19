import type { Vec3, ViewName } from './types.ts';

/** The directions the views look in. `dir` points from the part toward the viewer, as `projectEdges` wants it (F33). The view's y axis is dir x xAxis. */
export const viewFrames: Record<Exclude<ViewName, 'section'>, { dir: Vec3; x: Vec3 }> = {
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  iso: { dir: [1, -1, 1], x: [Math.SQRT1_2, Math.SQRT1_2, 0] },
};

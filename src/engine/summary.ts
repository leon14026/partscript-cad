import type { ModelPreview } from './protocol.ts';

/**
 * One sentence that names the faceted parts and why they are faceted, or an
 * empty string when every part is exact. A faceted part exports to STEP with
 * flat faces instead of true curves.
 */
export function facetedText(model: ModelPreview): string {
  const { parts } = model.assembly;
  const reasons = new Map<string, string>();
  let count = 0;
  parts.forEach((part, i) => {
    const mesh = model.meshes[model.partMesh[i]];
    if (mesh.quality !== 'faceted') return;
    count++;
    reasons.set(part.file ?? part.name, mesh.reason ?? 'shapes the exact builder lacks');
  });
  if (!count) return '';
  // A mesh with open edges has no true volume, and sewing it into a STEP solid can fail.
  const open = [...reasons.values()].some((reason) => /not closed/.test(reason)) ? ' A mesh that is not closed has no exact volume, and STEP export may fail.' : '';
  if (!model.isAssembly) return `This solid is faceted because it uses ${[...reasons.values()][0]}, so STEP has flat faces.${open}`;
  const items = [...reasons].map(([label, reason]) => `${label} uses ${reason}`);
  const shown = items.slice(0, 3).join(', ') + (items.length > 3 ? `, and ${items.length - 3} more` : '');
  return `${count} ${count === 1 ? 'part is' : 'parts are'} faceted (${shown}).${open}`;
}

/** Each part with its quality, one per line, for a tooltip. */
export function partQualities(model: ModelPreview): string {
  return model.assembly.parts.map((part, i) => `${part.name}: ${model.meshes[model.partMesh[i]].quality}`).join('\n');
}

/** From this many sides, a polygon where a round shape was probably meant is reported as an error. With fewer sides it is only logged. */
export const flatRoundErrorSides = 16;

interface FnLine {
  line: number;
  /** The number after `$fn =` on that line, when it is a plain number. */
  value?: number;
}

/** The lines of a source that use `$fn`, ignoring comments and strings. Lines count from 1. */
export function fnLines(source: string): FnLine[] {
  const blanked = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g, (text) => text.replace(/[^\n]/g, ' '));
  return blanked.split('\n').flatMap((text, i): FnLine[] => {
    if (!/\$fn\b/.test(text)) return [];
    const value = /\$fn\s*=\s*(\d+(?:\.\d+)?)/.exec(text);
    return [{ line: i + 1, value: value ? Number(value[1]) : undefined }];
  });
}

/** "48-sided", "24- and 48-sided", "24-, 48- and 64-sided". */
function sidesText(sides: number[]) {
  const list = [...new Set(sides)].sort((a, b) => a - b);
  return list.length === 1 ? `${list[0]}-sided` : `${list.slice(0, -1).map((n) => `${n}-`).join(', ')} and ${list[list.length - 1]}-sided`;
}

/** Where `$fn` is set: the lines that give one of these side counts, or every line that mentions `$fn` when none gives a plain number that matches. */
function setOnText(uses: FnLine[], sides: number[]) {
  const matching = uses.filter((use) => use.value !== undefined && sides.includes(Math.max(3, Math.trunc(use.value))));
  const lines = (matching.length ? matching : uses).map((use) => String(use.line));
  if (!lines.length) return 'set in an included file or a library';
  const shown = lines.length > 3 ? `${lines.slice(0, 3).join(', ')} and ${lines.length - 3} more` : lines.length > 1 ? `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}` : lines[0];
  return `set on line${lines.length > 1 ? 's' : ''} ${shown}`;
}

/**
 * What to tell the user about round shapes that `$fn` turned into flat-sided prisms in exact parts. The
 * build calls such a part exact, and it is, but its STEP holds a polygon where a hole or pin was meant.
 * `errors` are for shapes of flatRoundErrorSides or more, which were almost certainly meant to be round.
 * `logs` are for fewer, such as a hexagon, which are often meant. `files` are the sources of the build.
 */
export function flatRoundNotes(model: ModelPreview, files: Record<string, string>, entry: string): { errors: string[]; logs: string[] } {
  const errors: string[] = [];
  const logs: string[] = [];
  const seen = new Set<number>();
  model.assembly.parts.forEach((part, i) => {
    const index = model.partMesh[i];
    const rounds = model.meshes[index].flatRounds;
    if (!rounds?.length || seen.has(index)) return;
    seen.add(index);
    const file = part.file ?? entry;
    const where = part.inline ? `${file}, part("${part.name}")` : file;
    const uses = fnLines(files[file] ?? '');
    const text = (sides: number[]) => {
      const one = sides.length === 1;
      return `${where}: ${sides.length} ${one ? 'cylinder or circle is a' : 'cylinders or circles are'} ${sidesText(sides)} ${one ? 'polygon' : 'polygons'} in STEP, not true round (${setOnText(uses, sides)}).`;
    };
    const many = rounds.filter((sides) => sides >= flatRoundErrorSides);
    const few = rounds.filter((sides) => sides < flatRoundErrorSides);
    if (many.length) errors.push(`${text(many)} Delete $fn for true cylinders and round holes.`);
    if (few.length) logs.push(text(few));
  });
  return { errors, logs };
}

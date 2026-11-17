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
  if (!model.isAssembly) return `This solid is faceted because it uses ${[...reasons.values()][0]}, so STEP has flat faces.`;
  const items = [...reasons].map(([label, reason]) => `${label} uses ${reason}`);
  const shown = items.slice(0, 3).join(', ') + (items.length > 3 ? `, and ${items.length - 3} more` : '');
  return `${count} ${count === 1 ? 'part is' : 'parts are'} faceted (${shown}).`;
}

/** Each part with its quality, one per line, for a tooltip. */
export function partQualities(model: ModelPreview): string {
  return model.assembly.parts.map((part, i) => `${part.name}: ${model.meshes[model.partMesh[i]].quality}`).join('\n');
}

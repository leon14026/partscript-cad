import { arrowPoints, layerOrder, layerStyles } from './layers.ts';
import type { Entity, Sheet, Vec2 } from './types.ts';

/** A number with at most three decimals, so the same sheet always gives the same text. */
const n = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The sheet as an SVG document, in millimetres, the first line at the top as on paper. */
export function sheetToSvg(sheet: Sheet): string {
  const flip = (p: Vec2): Vec2 => [p[0], sheet.height - p[1]];
  const point = (p: Vec2) => {
    const q = flip(p);
    return `${n(q[0])},${n(q[1])}`;
  };
  const draw = (entity: Entity): string => {
    switch (entity.kind) {
      case 'line': {
        const [a, b] = [flip(entity.a), flip(entity.b)];
        return `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}"/>`;
      }
      case 'poly':
        return `<${entity.closed ? 'polygon' : 'polyline'} points="${entity.points.map(point).join(' ')}"/>`;
      case 'circle': {
        const c = flip(entity.c);
        return `<circle cx="${n(c[0])}" cy="${n(c[1])}" r="${n(entity.r)}"/>`;
      }
      case 'arc': {
        const start = flip([entity.c[0] + entity.r * Math.cos(entity.from), entity.c[1] + entity.r * Math.sin(entity.from)]);
        const end = flip([entity.c[0] + entity.r * Math.cos(entity.to), entity.c[1] + entity.r * Math.sin(entity.to)]);
        const large = entity.to - entity.from > Math.PI ? 1 : 0;
        return `<path d="M${n(start[0])},${n(start[1])} A${n(entity.r)},${n(entity.r)} 0 ${large} 0 ${n(end[0])},${n(end[1])}"/>`;
      }
      case 'arrow':
        return `<polygon fill="#000" stroke="none" points="${arrowPoints(entity.tip, entity.angle).map(point).join(' ')}"/>`;
      case 'text': {
        const at = flip(entity.at);
        const turn = entity.angle ? ` transform="rotate(${n((-entity.angle * 180) / Math.PI)} ${n(at[0])} ${n(at[1])})"` : '';
        return `<text x="${n(at[0])}" y="${n(at[1])}" font-size="${n(entity.height)}" text-anchor="${entity.anchor}" fill="#000" stroke="none"${turn}>${escapeXml(entity.text)}</text>`;
      }
    }
  };
  const groups = layerOrder.map((layer) => {
    const style = layerStyles[layer];
    const items = sheet.entities.filter((entity) => entity.layer === layer);
    if (!items.length) return '';
    const dash = style.dash ? ` stroke-dasharray="${style.dash.join(' ')}"` : '';
    // Strokes belong to the group; text and arrowheads are filled shapes and say so themselves.
    return `<g id="${layer}" fill="none" stroke="#000" stroke-width="${style.weight}"${dash} stroke-linecap="round" stroke-linejoin="round">\n  ${items.map(draw).join('\n  ')}\n</g>`;
  }).filter(Boolean);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(sheet.width)}mm" height="${n(sheet.height)}mm" viewBox="0 0 ${n(sheet.width)} ${n(sheet.height)}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${n(sheet.width)}" height="${n(sheet.height)}" fill="#fff"/>`,
    ...groups,
    '</svg>',
    '',
  ].join('\n');
}

import { zlibSync } from 'fflate';
import { textWidth } from './font.ts';
import { arrowPoints, layerOrder, layerStyles } from './layers.ts';
import type { Entity, Sheet, Vec2 } from './types.ts';

/** Points in a millimetre. A page is this much larger than the sheet's numbers, and the content scales them back. */
const pointsPerMm = 72 / 25.4;

const num = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/**
 * The characters the standard Helvetica can show, as the octal escapes of their WinAnsi codes. Ø, °, × and ± are the ones a drawing uses.
 * Anything else becomes a question mark rather than a wrong letter.
 */
function pdfText(text: string) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x5c || code === 0x28 || code === 0x29) out += `\\${character}`;
    else if (code >= 0x20 && code < 0x7f) out += character;
    else if (code >= 0xa0 && code <= 0xff) out += `\\${code.toString(8)}`;
    else out += '?';
  }
  return out;
}

/** A circular arc of at most a quarter turn as one Bézier curve, which is within 0.03 % of the arc. */
function arcCurve(c: Vec2, r: number, from: number, to: number) {
  const k = (4 / 3) * Math.tan((to - from) / 4);
  const [c0, s0, c1, s1] = [Math.cos(from), Math.sin(from), Math.cos(to), Math.sin(to)];
  const p = (x: number, y: number) => `${num(c[0] + r * x)} ${num(c[1] + r * y)}`;
  return `${p(c0 - k * s0, s0 + k * c0)} ${p(c1 + k * s1, s1 - k * c1)} ${p(c1, s1)} c`;
}

function arcOps(c: Vec2, r: number, from: number, to: number, move: boolean) {
  const sweep = to - from;
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const ops = move ? [`${num(c[0] + r * Math.cos(from))} ${num(c[1] + r * Math.sin(from))} m`] : [];
  for (let i = 0; i < pieces; i++) ops.push(arcCurve(c, r, from + (sweep * i) / pieces, from + (sweep * (i + 1)) / pieces));
  return ops;
}

function operations(entity: Entity): string[] {
  const at = (p: Vec2) => `${num(p[0])} ${num(p[1])}`;
  switch (entity.kind) {
    case 'line':
      return [`${at(entity.a)} m ${at(entity.b)} l S`];
    case 'poly':
      return [`${entity.points.map((p, i) => `${at(p)} ${i ? 'l' : 'm'}`).join(' ')}${entity.closed ? ' h' : ''} S`];
    case 'circle':
      return [...arcOps(entity.c, entity.r, 0, Math.PI * 2, true), 'h S'];
    case 'arc':
      return [...arcOps(entity.c, entity.r, entity.from, entity.to, true), 'S'];
    case 'arrow':
      return [`${arrowPoints(entity.tip, entity.angle).map((p, i) => `${at(p)} ${i ? 'l' : 'm'}`).join(' ')} h f`];
    case 'text': {
      // The anchor is measured along the text's own direction, so rotated text is shifted the same way.
      const shift = entity.anchor === 'middle' ? -textWidth(entity.text, entity.height) / 2 : entity.anchor === 'end' ? -textWidth(entity.text, entity.height) : 0;
      const [c, s] = [Math.cos(entity.angle), Math.sin(entity.angle)];
      const origin: Vec2 = [entity.at[0] + shift * c, entity.at[1] + shift * s];
      return [`BT /F1 ${num(entity.height)} Tf ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(origin[0])} ${num(origin[1])} Tm (${pdfText(entity.text)}) Tj ET`];
    }
  }
}

/** The page's drawing instructions: the layers in order, each with its line weight and dash, in millimetres. */
function content(sheet: Sheet) {
  const lines = [`q ${num(pointsPerMm)} 0 0 ${num(pointsPerMm)} 0 0 cm 1 J 1 j 0 G 0 g`];
  for (const layer of layerOrder) {
    const items = sheet.entities.filter((entity) => entity.layer === layer);
    if (!items.length) continue;
    const style = layerStyles[layer];
    lines.push(`${num(style.weight)} w ${style.dash ? `[${style.dash.join(' ')}] 0 d` : '[] 0 d'}`);
    for (const entity of items) lines.push(...operations(entity));
  }
  lines.push('Q');
  return lines.join('\n');
}

const ascii = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);

/**
 * The sheets as one PDF with a page each: vector lines and the standard Helvetica, so it holds no font file. It carries no creation
 * time, so the same sheets always make the same bytes. The title block's date comes from the dialog.
 */
export function sheetsToPdf(sheets: Sheet[], title: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (bytes: Uint8Array | string) => {
    const data = typeof bytes === 'string' ? ascii(bytes) : bytes;
    chunks.push(data);
    length += data.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    write(`${id} 0 obj\n${body}`);
    if (stream) {
      write('\nstream\n');
      write(stream);
      write('\nendstream');
    }
    write('\nendobj\n');
  };

  write('%PDF-1.4\n%âãÏÓ\n');
  const pageIds = sheets.map((_, i) => 5 + i * 2);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${sheets.length} >>`);
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  object(4, `<< /Title (${pdfText(title)}) /Producer (Partscript CAD) >>`);
  sheets.forEach((sheet, i) => {
    const [width, height] = [sheet.width * pointsPerMm, sheet.height * pointsPerMm];
    object(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    const packed = zlibSync(ascii(content(sheet)), { level: 6 });
    object(pageIds[i] + 1, `<< /Length ${packed.length} /Filter /FlateDecode >>`, packed);
  });

  const count = 5 + sheets.length * 2;
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

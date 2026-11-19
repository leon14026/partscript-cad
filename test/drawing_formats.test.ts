import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import { OcctKernel } from 'occt-wasm';
import { sheetToDxf } from '../src/drawing/dxf.ts';
import { exportDrawings, fileStem } from '../src/drawing/export.ts';
import { textWidth } from '../src/drawing/font.ts';
import { sheetsToPdf } from '../src/drawing/pdf.ts';
import { buildSheet, defaultOptions } from '../src/drawing/sheet.ts';
import { sheetToSvg } from '../src/drawing/svg.ts';
import type { Entity, Sheet } from '../src/drawing/types.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

/** A sheet written by hand, 100 by 50 mm, so every number a writer should give can be worked out here. */
const small: Sheet = {
  name: 'small', width: 100, height: 50, scale: '1:1', notes: [],
  entities: [
    { kind: 'line', layer: 'OUTLINE', a: [10, 10], b: [60, 10] },
    { kind: 'circle', layer: 'OUTLINE', c: [30, 25], r: 4 },
    { kind: 'arc', layer: 'OUTLINE', c: [50, 25], r: 5, from: 0, to: Math.PI / 2 },
    { kind: 'line', layer: 'HIDDEN', a: [10, 20], b: [60, 20] },
    { kind: 'arrow', layer: 'DIM', tip: [60, 10], angle: 0 },
    { kind: 'poly', layer: 'OUTLINE', points: [[0, 0], [5, 0], [5, 5]], closed: true },
    { kind: 'text', layer: 'DIM', at: [10, 40], text: 'Ø8 THRU', height: 3, anchor: 'start', angle: 0 },
    { kind: 'text', layer: 'TEXT', at: [90, 5], text: 'A & B <C> "D" (E)', height: 2, anchor: 'end', angle: 0 },
  ],
};

test('the PDF has the page size of the sheet, the lines in millimetres, and Ø as its WinAnsi code', () => {
  const pdf = latin1(sheetsToPdf([small], 'small'));
  // 100 mm is 100 / 25.4 x 72 = 283.465 points, and 50 mm is 141.732.
  assert.ok(pdf.includes('/MediaBox [0 0 283.465 141.732]'));
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.endsWith('%%EOF\n'));
  const stream = pdf.slice(pdf.indexOf('stream\n') + 7, pdf.indexOf('\nendstream'));
  const content = strFromU8(unzlibSync(Uint8Array.from(stream, (c) => c.charCodeAt(0))));
  assert.ok(content.startsWith('q 2.835 0 0 2.835 0 0 cm'), content.slice(0, 40));
  // Layers: outline lines 0.5 mm, hidden lines 0.25 mm dashed 3 on and 1.5 off.
  assert.ok(content.includes('0.5 w [] 0 d\n10 10 m 60 10 l S'));
  assert.ok(content.includes('0.25 w [3 1.5] 0 d\n10 20 m 60 20 l S'));
  // The circle starts at its right-hand point (30 + 4, 25), and the first quarter's control point is 4 x 0.5523 above it: 27.209.
  assert.ok(content.includes('34 25 m\n34 27.209 '), content.slice(content.indexOf('34 25 m'), content.indexOf('34 25 m') + 60));
  // Ø is code 216, which is 330 in octal. The text brackets and backslashes are escaped.
  assert.ok(content.includes('(\\3308 THRU) Tj'));
  assert.ok(content.includes('(A & B <C> "D" \\(E\\)) Tj'));
  // Right-aligned text starts to the left by its width, from Helvetica's widths, so the text ends at x = 90.
  const left = Math.round((90 - textWidth('A & B <C> "D" (E)', 2)) * 1000) / 1000;
  assert.ok(content.includes(`1 0 0 1 ${left} 5 Tm (A & B`), `starts at ${left}`);
  assert.ok(content.includes('h f'), 'the arrowhead is filled');
});

test('the PDF is the same bytes twice, has no date, and its table of offsets and stream lengths are right', () => {
  const first = sheetsToPdf([small, { ...small, name: 'second' }], 'two');
  const second = sheetsToPdf([small, { ...small, name: 'second' }], 'two');
  assert.deepEqual(first, second);
  const pdf = latin1(first);
  assert.ok(!/CreationDate|ModDate/.test(pdf));
  assert.ok(pdf.includes('/Count 2'));
  // Every offset in the table is where its object starts.
  // ("startxref" ends in "xref", so the table is found by the newline in front of it.)
  const tableAt = pdf.lastIndexOf('\nxref\n') + 1;
  const table = pdf.slice(tableAt);
  const entries = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  assert.equal(entries.length, 4 + 2 * 2, 'four fixed objects and two for each page');
  entries.forEach((offset, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, offset), `object ${i + 1} is not at ${offset}`));
  assert.equal(Number(/startxref\n(\d+)\n/.exec(pdf)![1]), tableAt);
  // Every stream is as long as it says, and inflates to drawing instructions.
  const streams = [...pdf.matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)];
  assert.equal(streams.length, 2);
  for (const match of streams) {
    const start = match.index! + match[0].length;
    assert.equal(pdf.slice(start + Number(match[1]), start + Number(match[1]) + 10), '\nendstream');
    const body = strFromU8(unzlibSync(Uint8Array.from(pdf.slice(start, start + Number(match[1])), (c) => c.charCodeAt(0))));
    assert.ok(body.startsWith('q ') && body.endsWith('\nQ'));
  }
});

test('the DXF is R12 with six layers, and writes the circle, arc, text and arrow as the format wants', () => {
  const dxf = sheetToDxf(small);
  assert.deepEqual(dxf, sheetToDxf(small));
  assert.ok(dxf.startsWith('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n'));
  assert.ok(dxf.endsWith('0\nENDSEC\n0\nEOF\n'));
  for (const layer of ['OUTLINE', 'HIDDEN', 'DIM', 'HATCH', 'TEXT', 'BORDER']) assert.ok(dxf.includes(`0\nLAYER\n2\n${layer}\n`), layer);
  // A circle of radius 4 at (30, 25), and an arc of radius 5 from 0 to 90 degrees.
  assert.ok(dxf.includes('0\nCIRCLE\n8\nOUTLINE\n10\n30\n20\n25\n30\n0\n40\n4\n'));
  assert.ok(dxf.includes('0\nARC\n8\nOUTLINE\n10\n50\n20\n25\n30\n0\n40\n5\n50\n0\n51\n90\n'));
  // Ø is %%c. The arrow is a SOLID: the tip (60, 10), then 3 back along the line, 0.55 to each side, the third corner twice.
  assert.ok(dxf.includes('1\n%%c8 THRU\n'));
  assert.ok(dxf.includes('0\nSOLID\n8\nDIM\n10\n60\n20\n10\n30\n0\n11\n57\n21\n10.55\n31\n0\n12\n57\n22\n9.45\n32\n0\n13\n57\n23\n9.45\n33\n0\n'));
  // Right-aligned text carries its alignment point in 11 and 21.
  assert.ok(dxf.includes('72\n2\n11\n90\n21\n5\n'));
  // A closed outline is a closed POLYLINE with three vertices.
  assert.equal((dxf.match(/0\nVERTEX\n/g) ?? []).length, 3);
  assert.ok(dxf.includes('0\nPOLYLINE\n8\nOUTLINE\n66\n1\n10\n0\n20\n0\n30\n0\n70\n1\n'));
});

test('the SVG is well formed, escapes text, and has one element for each entity', () => {
  const svg = sheetToSvg(small);
  assert.deepEqual(svg, sheetToSvg(small));
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50"'));
  assert.ok(svg.includes('A &amp; B &lt;C&gt; &quot;D&quot; (E)'));
  assert.equal((svg.match(/<g /g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
  assert.equal((svg.match(/<line /g) ?? []).length, small.entities.filter((entity) => entity.kind === 'line').length);
  assert.equal((svg.match(/<circle /g) ?? []).length, 1);
  assert.equal((svg.match(/<text /g) ?? []).length, 2);
  // y grows down in SVG: the line at y = 10 on a 50 mm sheet is at 40.
  assert.ok(svg.includes('x1="10" y1="40" x2="60" y2="40"'));
  // Every tag opened is closed or self-closed.
  const tags = [...svg.matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)];
  const stack: string[] = [];
  for (const [, closing, name, selfClosing] of tags) {
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name);
    else stack.push(name);
  }
  assert.deepEqual(stack, []);
});

test('several sheets go in one PDF, or in a zip of one file each, and the same names do not overwrite one another', () => {
  const two = [small, { ...small, name: 'small' }];
  const pdf = exportDrawings(two, 'pdf', 'my project');
  assert.equal(pdf.name, 'my_project-drawings.pdf');
  assert.ok(latin1(pdf.data).includes('/Count 2'));
  const zip = exportDrawings(two, 'dxf', 'my project');
  assert.equal(zip.name, 'my_project-drawings.zip');
  assert.deepEqual(Object.keys(unzipSync(zip.data)).sort(), ['small.dxf', 'small_2.dxf']);
  assert.deepEqual(exportDrawings(two, 'svg', 'x').data, exportDrawings(two, 'svg', 'x').data, 'the same zip twice');
  const one = exportDrawings([small], 'svg', 'x');
  assert.equal(one.name, 'small.svg');
  assert.equal(one.type, 'image/svg+xml');
  assert.equal(fileStem('a b/c?'), 'a_b_c');
  assert.equal(fileStem('???'), 'drawing');
});

test('the plate drawn through the whole chain has its hole as a circle of radius 4 in the DXF, at 10 and 15 from the corner', async () => {
  const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
  const wasm = await readFile(new URL('openscad.wasm', engine));
  const { default: instantiate } = await import(engine.href);
  const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
  const kernel = await OcctKernel.init();
  const builder = new ModelBuilder(kernel, openScad);
  const model = await builder.build({ 'a.scad': 'part("plate") { difference() { cube([40, 30, 5]); translate([10, 15, -1]) cylinder(d = 8, h = 7); } }' }, 'a.scad');
  const sheet = buildSheet(builder.draw(model, {}).parts[0], defaultOptions());
  const dxf = sheetToDxf(sheet);
  // The scale is 1:1, so the circle's radius is 4 on the sheet. The title block's symbol has circles of 3.4 and 1.7, so this is the only 4.
  const circles = [...dxf.matchAll(/0\nCIRCLE\n8\nOUTLINE\n10\n([-\d.]+)\n20\n([-\d.]+)\n30\n0\n40\n([-\d.]+)\n/g)].map((match) => match.slice(1).map(Number));
  const holes = circles.filter((circle) => Math.abs(circle[2] - 4) < 1e-9);
  assert.equal(holes.length, 1);
  // The face's left side is the line of the sheet 30 long that stands furthest left; its lower end is the corner.
  const lines = sheet.entities.filter((entity): entity is Extract<Entity, { kind: 'line' }> => entity.kind === 'line' && entity.layer === 'OUTLINE');
  const sides = lines.filter((line) => Math.abs(line.a[0] - line.b[0]) < 1e-9 && Math.abs(Math.abs(line.a[1] - line.b[1]) - 30) < 1e-9);
  const left = sides.reduce((best, line) => (line.a[0] < best.a[0] ? line : best));
  const corner = [left.a[0], Math.min(left.a[1], left.b[1])];
  assert.ok(Math.abs(holes[0][0] - corner[0] - 10) < 1e-3, `across: ${holes[0][0] - corner[0]}`);
  assert.ok(Math.abs(holes[0][1] - corner[1] - 15) < 1e-3, `up: ${holes[0][1] - corner[1]}`);
  // The same sheet through the PDF has Ø8 as its callout.
  const pdf = latin1(sheetsToPdf([sheet], 'plate'));
  const content = strFromU8(unzlibSync(Uint8Array.from(pdf.slice(pdf.indexOf('stream\n') + 7, pdf.indexOf('\nendstream')), (c) => c.charCodeAt(0))));
  assert.ok(content.includes('(\\3308 THRU) Tj'));
  kernel.releaseAll();
});

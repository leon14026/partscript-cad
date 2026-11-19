import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { exampleProjects } from '../src/examples.ts';
import { drawingArea, chooseViews, padding, sheetSizes } from '../src/drawing/layout.ts';
import { textWidth } from '../src/drawing/font.ts';
import { hatchLines, style } from '../src/drawing/dimensions.ts';
import { readDrawingOptions } from '../src/drawing/options.ts';
import { buildSheet, buildSheets, defaultOptions } from '../src/drawing/sheet.ts';
import type { Entity, Sheet, Vec2 } from '../src/drawing/types.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
import { readProject, readProjectZip, serializeProject, serializeProjectZip } from '../src/project.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

function near(actual: number, expected: number, tolerance = 1e-3) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

/** Build one file and read its drawing. */
async function drawn(source: string, files: Record<string, string> = {}) {
  const model = await builder.build({ 'a.scad': source, ...files }, 'a.scad');
  return { model, drawing: builder.draw(model, {}) };
}

const texts = (sheet: Sheet) => sheet.entities.flatMap((entity) => (entity.kind === 'text' ? [entity.text] : []));
const kinds = (sheet: Sheet, layer: string) => sheet.entities.filter((entity): entity is Extract<Entity, { kind: 'line' }> => entity.kind === 'line' && entity.layer === layer);

const plate = 'part("plate") { difference() { cube([40, 30, 5]); translate([10, 15, -1]) cylinder(d = 8, h = 7); } }';

test('the plate of F15 gets two views, overall sizes 40, 30 and 5, one callout, and the places 10 and 15', async () => {
  const { drawing } = await drawn(plate);
  const part = drawing.parts[0];
  assert.deepEqual(part.names, ['plate']);
  assert.equal(part.quality, 'exact');
  assert.equal(part.holes.length, 1);
  const [hole] = part.holes;
  assert.equal(hole.axis, 2);
  assert.equal(hole.through, true);
  near(hole.diameter, 8);
  near(hole.at[0], 10);
  near(hole.at[1], 15);
  // 5 is under 15 % of 40, and 30 is over it, so the part is a plate: the face and one edge.
  assert.deepEqual(chooseViews(part), ['top', 'front']);
  assert.equal(part.section, undefined);

  const sheet = buildSheet(part, defaultOptions());
  // It fits at full size: 40 + 36 across and 30 + 5 down with their lanes are well inside the 249.4 by 145.9 mm of the sheet.
  assert.equal(sheet.scale, '1:1');
  const words = texts(sheet);
  for (const wanted of ['40', '30', '5', 'Ø8 THRU', '10', '15']) assert.ok(words.includes(wanted), `no "${wanted}" in ${JSON.stringify(words)}`);
  assert.ok(!words.some((word) => word.startsWith('SECTION')));
  assert.equal(words.filter((word) => word.includes('THRU')).length, 1);
  assert.deepEqual(sheet.notes, []);

  // The hole is a circle of radius 4 on the sheet at 1:1, 10 across and 15 up from the lower left corner of the face.
  const circle = sheet.entities.find((entity): entity is Extract<Entity, { kind: 'circle' }> => entity.kind === 'circle' && Math.abs(entity.r - 4) < 1e-6)!;
  assert.ok(circle, 'the hole is not a circle of radius 4');
  const upright = kinds(sheet, 'OUTLINE').filter((line) => Math.abs(line.a[0] - line.b[0]) < 1e-6 && Math.abs(Math.abs(line.a[1] - line.b[1]) - 30) < 1e-6);
  assert.equal(upright.length, 2, 'the face has two 30 mm sides');
  const [left, bottom] = [Math.min(...upright.map((line) => line.a[0])), Math.min(...upright.flatMap((line) => [line.a[1], line.b[1]]))];
  near(circle.c[0] - left, 10);
  near(circle.c[1] - bottom, 15);
});

test('a 400 by 300 by 20 plate is drawn at the largest listed scale that fits, 1:5', async () => {
  const { drawing } = await drawn('part("big") { difference() { cube([400, 300, 20]); translate([100, 150, -1]) cylinder(d = 8, h = 22); } }');
  const sheet = buildSheet(drawing.parts[0], defaultOptions());
  // Two views stand one above the other, so their heights add: 300 + 20 mm at the scale, and each carries the padding above (9) and
  // below (22) it. The top view also has one row of callouts, 7 mm. The room is what the sheet leaves above the title block, from drawingArea.
  const area = drawingArea('ansi-a');
  const room = area.top - area.bottom;
  const need = (scale: number) => 320 * scale + 2 * (padding.top + padding.bottom) + 7;
  assert.ok(need(1 / 2) > room, `1:2 would need ${need(1 / 2)} mm of ${room}`);
  assert.ok(need(1 / 5) <= room, `1:5 needs ${need(1 / 5)} mm of ${room}`);
  assert.equal(sheet.scale, '1:5');
  assert.deepEqual(sheet.notes, []);
});

test('a 40 by 30 by 20 block with an 8 mm hole 12 mm deep gets a section whose cut face is 704 mm²', async () => {
  const { drawing } = await drawn('part("blind") { difference() { cube([40, 30, 20]); translate([10, 15, 8]) cylinder(d = 8, h = 13); } }');
  const part = drawing.parts[0];
  const [hole] = part.holes;
  assert.equal(hole.through, false);
  near(hole.diameter, 8);
  near(hole.depth, 12);
  assert.ok(part.section, 'no section');
  // The plane runs through the hole's axis, so it cuts 40 across and 20 up, less the hole's 8 by 12: 800 - 96.
  near(part.section!.area, 704, 0.5);
  // The revision is B here, so that the only A's are the two ends of the cutting line.
  const sheet = buildSheet(part, { ...defaultOptions(), title: { ...defaultOptions().title, revision: 'B' } });
  const words = texts(sheet);
  assert.ok(words.includes('Ø8 DEEP 12'));
  assert.ok(words.includes('SECTION A-A'));
  assert.equal(words.filter((word) => word === 'A').length, 2, 'the cutting line has an A at each end');
  assert.ok(kinds(sheet, 'HATCH').length > 10);
  assert.deepEqual(chooseViews(part), ['front', 'top', 'right', 'iso']);
});

test('a counterbored hole is one callout with both diameters, and the section shows it', async () => {
  const { drawing } = await drawn('part("stepped") { difference() { cube([40, 30, 20]); translate([20, 15, -1]) cylinder(d = 6, h = 22); translate([20, 15, 12]) cylinder(d = 11, h = 9); } }');
  const [hole] = drawing.parts[0].holes;
  near(hole.diameter, 6);
  assert.equal(hole.through, true);
  near(hole.bore!.diameter, 11);
  near(hole.bore!.depth, 8);
  // 20 high, with the bore taking the top 8: the cut is 40 x 20 less 6 x 12 (the through part) and 11 x 8 (the bore) = 800 - 72 - 88.
  near(drawing.parts[0].section!.area, 640, 0.5);
  const words = texts(buildSheet(drawing.parts[0], defaultOptions()));
  assert.ok(words.includes('Ø6 THRU'));
  assert.ok(words.includes('CBORE Ø11 DEEP 8'));
});

test('four equal holes are one callout, and a second diameter is a second callout', async () => {
  const { drawing } = await drawn('part("p") { difference() { cube([60, 40, 5]); for (x = [6, 54], y = [6, 34]) translate([x, y, -1]) cylinder(d = 3.4, h = 7); translate([30, 20, -1]) cylinder(d = 12, h = 7); } }');
  assert.equal(drawing.parts[0].holes.length, 5);
  const words = texts(buildSheet(drawing.parts[0], defaultOptions()));
  assert.ok(words.includes('4X Ø3.4 THRU'));
  assert.ok(words.includes('Ø12 THRU'));
  assert.equal(words.filter((word) => word.includes('THRU')).length, 2);
  // The four are 6 and 54 across and 6 and 34 up; the centre is 30 and 20. Each position is named once.
  for (const place of ['6', '54', '34', '30', '20']) assert.ok(words.includes(place), `no ${place}`);
});

test('a hole in a $fn = 64 prism is read as Ø8 over its corners, and the note says where to change it', async () => {
  const { model, drawing } = await drawn('part("round") { difference() { cube([40, 30, 5]); translate([10, 15, -1]) cylinder(d = 8, h = 7, $fn = 64); } }');
  const [hole] = drawing.parts[0].holes;
  assert.equal(hole.sides, 64);
  // OpenSCAD puts the corners of the polygon on the circle of the diameter given.
  near(hole.diameter, 8, 1e-3);
  const plain = buildSheet(drawing.parts[0], defaultOptions());
  assert.ok(plain.notes.some((note) => note.includes('64-sided polygon') && note.includes('Delete $fn')), JSON.stringify(plain.notes));
  assert.ok(texts(plain).includes('Ø8 THRU'));
  // With the page's context the note names the file and the line.
  const { polygonHoleNote } = await import('../src/engine/summary.ts');
  const files = { 'a.scad': 'part("round") { difference() {\n cube([40, 30, 5]);\n translate([10, 15, -1]) cylinder(d = 8, h = 7, $fn = 64);\n} }' };
  const sheet = buildSheet(drawing.parts[0], defaultOptions(), {
    polygonNote: (part, found) => polygonHoleNote(model.preview, files, 'a.scad', part.names[0], found.diameter, found.sides ?? 0),
  });
  assert.ok(sheet.notes.some((note) => note.startsWith('a.scad, part("round")') || note.startsWith('a.scad')) && sheet.notes.some((note) => note.includes('line 3')), JSON.stringify(sheet.notes));
});

test('a turned shaft is dimensioned by its diameters and the length of each step', async () => {
  const { drawing } = await drawn('part("shaft") { rotate([0, 90, 0]) union() { cylinder(d = 20, h = 30); translate([0, 0, 30]) cylinder(d = 12, h = 40); } }');
  const turned = drawing.parts[0].turned!;
  assert.equal(turned.steps.length, 2);
  near(turned.steps[0].diameter, 20);
  near(turned.steps[1].diameter, 12);
  const words = texts(buildSheet(drawing.parts[0], defaultOptions()));
  for (const wanted of ['Ø20', 'Ø12', '30', '40', '70']) assert.ok(words.includes(wanted), `no ${wanted} in ${JSON.stringify(words)}`);
});

test('the faceted ring is drawn with the preview\'s crease edges only, is dimensioned overall, and says it is faceted', async () => {
  const { drawing } = await drawn('part("ring") { rotate_extrude($fn = 48) translate([10, 0]) circle(r = 3, $fn = 24); }');
  const part = drawing.parts[0];
  assert.equal(part.quality, 'faceted');
  assert.equal(part.holes.length, 0);
  for (const view of part.views) assert.ok(view.visible.length < 40, `${view.name} has ${view.visible.length} visible curves`);
  const sheet = buildSheet(part, defaultOptions());
  assert.ok(sheet.notes.some((note) => note.startsWith('Faceted part')), JSON.stringify(sheet.notes));
  // The ring is 26 across (10 + 3 each side of 10) and 6 high: 2 x (10 + 3) and 2 x 3.
  const words = texts(sheet);
  assert.ok(words.includes('26'));
  assert.ok(words.includes('6'));
  assert.equal(words.filter((word) => word.includes('THRU')).length, 0);
});

test('the hull of two cubes draws the outline of its front view in 4 curves, 75.62 mm', async () => {
  const { drawing } = await drawn('part("h") { hull() { cube([10, 10, 10]); translate([20, 5, 0]) cube([10, 10, 5]); } }');
  const front = drawing.parts[0].views.find((view) => view.name === 'front')!;
  assert.equal(drawing.parts[0].quality, 'faceted');
  // Seen along y the hull is the polygon (0,0) (30,0) (30,5) (10,10) (0,10): its faces turn by under 28 degrees where the front faces meet,
  // so only the outline is drawn. The two top edges, 10 long and sqrt(20 squared + 5 squared) long, bend by 14 degrees and are one polyline.
  assert.equal(front.visible.length, 4);
  const lengths = front.visible.map((curve) => {
    const points = curve.kind === 'line' ? [curve.a, curve.b] : curve.kind === 'poly' ? curve.points : [];
    return points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - points[i][0], point[1] - points[i][1]), 0);
  });
  near(lengths.reduce((a, b) => a + b, 0), 10 + 30 + 5 + 10 + Math.sqrt(425), 1e-3);
});

test('two parts with the same geometry are one sheet and one row of the parts list, with quantity 2', async () => {
  const body = 'part("p1", "peg.scad"); part("p2", "peg.scad", at = [30, 0, 0]); part("plate", "plate.scad", at = [0, 20, 0]);';
  const { drawing } = await drawn(body, { 'peg.scad': 'cylinder(d = 6, h = 20);', 'plate.scad': 'cube([40, 10, 4]);' });
  assert.equal(drawing.parts.length, 2);
  assert.equal(drawing.parts[0].quantity, 2);
  assert.deepEqual(drawing.parts[0].names, ['p1', 'p2']);
  const assembly = drawing.assembly!;
  assert.equal(assembly.items.length, 2);
  assert.deepEqual(assembly.items.map((item) => [item.item, item.name, item.quantity]), [[1, 'p1, p2', 2], [2, 'plate', 1]]);
  // The peg is 6 across and 20 long; the plate is 40 by 10 by 4.
  near(assembly.items[0].size[0], 6, 0.05);
  near(assembly.items[0].size[2], 20, 0.05);
  assert.deepEqual(assembly.items[1].size.map((value) => Math.round(value * 100) / 100), [40, 10, 4]);
  // One balloon for each of the three parts, the two pegs sharing item 1.
  assert.deepEqual(assembly.balloons.map((balloon) => balloon.item), [1, 1, 2]);
  const sheets = buildSheets(drawing, defaultOptions());
  assert.equal(sheets.length, 3, 'the assembly sheet and one for each distinct part');
  assert.ok(texts(sheets[0]).includes('p1, p2'));
  assert.ok(texts(sheets[1]).some((word) => word.includes('QTY 2')));
});

test('the swivel arm: a sheet for the assembly and each part, sizes from the model, and a balloon for every part', async () => {
  const swivel = exampleProjects.find((item) => item.name === 'Swivel arm assembly')!;
  const model = await builder.build(swivel.files, swivel.open);
  const started = performance.now();
  const drawing = builder.draw(model, {});
  const took = performance.now() - started;
  const sheets = buildSheets(drawing, defaultOptions());
  assert.equal(sheets.length, 5);
  const assembly = drawing.assembly!;
  assert.deepEqual(assembly.items.map((item) => item.name), ['base', 'turret', 'arm', 'carriage']);
  // The base is the 80 by 80 by 22 plate with its boss; the sheet's overall sizes are 80 and 22.
  assert.deepEqual(assembly.items[0].size.map((value) => Math.round(value * 100) / 100), [80, 80, 22]);
  assert.equal(assembly.balloons.length, 4);
  assert.ok(assembly.balloons.every((balloon) => !balloon.hidden));
  for (const balloon of assembly.balloons) {
    assert.ok(balloon.point[0] >= assembly.view.box[0] - 1 && balloon.point[0] <= assembly.view.box[2] + 1, 'a balloon leader ends outside the view');
    assert.ok(balloon.point[1] >= assembly.view.box[1] - 1 && balloon.point[1] <= assembly.view.box[3] + 1);
  }
  const base = drawing.parts.find((part) => part.names[0] === 'base')!;
  assert.equal(base.holes.length, 4);
  assert.ok(texts(buildSheet(base, defaultOptions())).includes('4X Ø5 THRU'));
  console.log(`swivel arm drawing set: ${Math.round(took)} ms`);
  assert.ok(took < 10_000, `the set took ${Math.round(took)} ms`);
  const one = performance.now();
  buildSheet(base, defaultOptions());
  assert.ok(performance.now() - one < 2000);
});

test('first angle puts the right view on the left and the sheet size follows the choice', async () => {
  const { drawing } = await drawn('part("b") { cube([40, 30, 20]); }');
  const third = buildSheet(drawing.parts[0], defaultOptions());
  const first = buildSheet(drawing.parts[0], { ...defaultOptions(), projection: 'first' });
  assert.ok(texts(third).includes('THIRD ANGLE'));
  assert.ok(texts(first).includes('FIRST ANGLE'));
  const a3 = buildSheet(drawing.parts[0], { ...defaultOptions(), size: 'a3' });
  assert.equal(a3.width, sheetSizes.a3.width);
  assert.equal(a3.height, sheetSizes.a3.height);
  // The same views in the same sheet are in different places.
  assert.notDeepEqual(third.entities, first.entities);
});

test('hatching covers the cut face once: a 10 mm square with a 4 mm square hole takes 84 mm²/3 mm of line', () => {
  // An outline is closed by repeating its first point, as the section's outlines are.
  const square = (x0: number, y0: number, size: number): Vec2[] => [[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]];
  const length = (lines: [Vec2, Vec2][]) => lines.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
  const solid = length(hatchLines([square(0, 0, 10)], style.hatchSpacing));
  const holed = length(hatchLines([square(0, 0, 10), square(3, 3, 4)], style.hatchSpacing));
  // Lines a spacing s apart cover an area A with about A / s of line.
  near(solid, 100 / style.hatchSpacing, 3);
  near(holed, 84 / style.hatchSpacing, 3);
  assert.ok(holed < solid);
});

test('text is placed by Helvetica widths: Ø8 at height 1 is 778 + 556 thousandths', () => {
  near(textWidth('Ø8', 1), 1.334, 1e-9);
  near(textWidth('40', 2.5), 2.78, 1e-9);
});

test('the drawing settings are kept in the project file and the draft, and a bad value falls back to its default', () => {
  const settings = { size: 'a4' as const, projection: 'first' as const, hidden: 'off' as const, title: { drawnBy: 'LEON', date: '2026-11-18', revision: 'B', material: '6061-T6' } };
  const project = { files: [{ name: 'a.scad', source: 'cube(1);' }], active: 'a.scad', entry: null, drawing: settings };
  assert.deepEqual(readProjectZip(serializeProjectZip(project)).drawing, settings);
  assert.deepEqual(readProject(JSON.parse(serializeProject(project)))!.drawing, settings);
  // A project saved without them has no such key.
  const plain = readProjectZip(serializeProjectZip({ ...project, drawing: undefined }));
  assert.equal('drawing' in plain, false);
  const bad = readDrawingOptions({ size: 'huge', projection: 'sideways', hidden: 1, title: { drawnBy: 'x'.repeat(100), revision: 7 } })!;
  assert.deepEqual(bad, { ...defaultOptions(), title: { ...defaultOptions().title, drawnBy: 'x'.repeat(40) } });
  assert.equal(readDrawingOptions(undefined), undefined);
});

test('eight holes of eight diameters in a row get six callouts, and the note names the two that did not fit', async () => {
  // Eight diameters, 2 to 3.4 in steps of 0.2, at x = 190, 193.6 ... 215.2 and y 5 in a plate 400 long. At the scale that fits, 3.6 mm is under 2 mm on the sheet, so the text of any two callouts overlaps and each needs a row of its own: six rows are allowed.
  const holes = Array.from({ length: 8 }, (_, i) => `translate([${(190 + 3.6 * i).toFixed(1)}, 5, -1]) cylinder(d = ${(2 + 0.2 * i).toFixed(1)}, h = 7);`).join(' ');
  const { drawing } = await drawn(`part("row") { difference() { cube([400, 12, 5]); ${holes} } }`);
  assert.equal(drawing.parts[0].holes.length, 8);
  const sheet = buildSheet(drawing.parts[0], defaultOptions());
  const drawnCallouts = texts(sheet).filter((word) => word.includes('THRU') && word.startsWith('Ø'));
  assert.equal(drawnCallouts.length, 6, JSON.stringify(drawnCallouts));
  const note = sheet.notes.find((line) => line.includes('did not fit above'));
  assert.ok(note?.startsWith('2 hole callouts did not fit above the top view and are not drawn: '), JSON.stringify(sheet.notes));
  // Every one of the eight diameters is either drawn or named in the note.
  for (let i = 0; i < 8; i++) {
    const wanted = `Ø${(2 + 0.2 * i).toFixed(1).replace(/\.0$/, '')} THRU`;
    assert.ok(drawnCallouts.includes(wanted) || note!.includes(wanted), `${wanted} is neither drawn nor listed`);
  }
});

test('an imported STEP is drawn with no hidden lines unless asked, a hole of Ø4 or less is left undimensioned and the sheet says so', async () => {
  // A plate 50 x 30 x 8 with a hole of Ø3 at (10, 15) and one of Ø6 at (35, 15), exported and read back as an imported part.
  const original = await builder.build({ 'a.scad': 'part("plate") difference() { cube([50, 30, 8]); translate([10, 15, -1]) cylinder(d = 3, h = 10); translate([35, 15, -1]) cylinder(d = 6, h = 10); }' }, 'a.scad');
  const step = builder.exportStep(original);
  const model = await builder.build({ 'b.scad': 'part("plate", "plate.step");' }, 'b.scad', undefined, { 'plate.step': step });
  const drawing = builder.draw(model, {});
  const part = drawing.parts[0];
  assert.equal(part.imported, true);
  assert.equal(part.holes.length, 2);
  const sheet = buildSheet(part, defaultOptions());
  const words = texts(sheet);
  assert.ok(words.includes('Ø6 THRU'), JSON.stringify(words));
  assert.ok(!words.some((word) => word.startsWith('Ø3')), 'the Ø3 hole is not dimensioned');
  assert.ok(sheet.notes.some((note) => note.startsWith('1 hole of Ø4 or less on an imported part is drawn but not dimensioned')), JSON.stringify(sheet.notes));
  assert.equal(kinds(sheet, 'HIDDEN').length, 0, 'an imported part has no hidden lines in the default setting');
  const asked = buildSheet(part, { ...defaultOptions(), hidden: 'on' });
  assert.ok(kinds(asked, 'HIDDEN').length > 0 || asked.entities.some((entity) => 'layer' in entity && entity.layer === 'HIDDEN'), 'Always draws them');
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { swivelArm } from '../src/assemblyExample.ts';
import { defaultPose, poseBounds, solvePose } from '../src/engine/assembly.ts';
import { assetFormat, unreadableFormat } from '../src/engine/assets.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import { flipTriangles, meshVolume, parseBinaryStl, parseStl, toBinaryStl } from '../src/engine/mesh.ts';
import { CadError, MAX_ASSET_BYTES, type ProjectAssets, type ProjectFiles } from '../src/engine/protocol.ts';
import { evaluateScad, renderMesh, type OpenScadFactory } from '../src/engine/scad.ts';
import { examples } from '../src/examples.ts';
import { importedMeshing } from '../src/engine/solid.ts';
import { facetedText } from '../src/engine/summary.ts';
import { assetFilename, isAsset, projectProblem, readProject, readProjectZip, serializeProject, serializeProjectZip, toAssets, toFiles, uniqueName, type Project } from '../src/project.ts';
import { strToU8, zipSync } from 'fflate';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad);

after(() => kernel.releaseAll());

function near(actual: number, expected: number, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${expected}, received ${actual}`);
}

const build = (files: ProjectFiles, entry: string, assets: ProjectAssets = {}) => builder.build(files, entry, undefined, assets);

/** The STL OpenSCAD makes of some shapes. */
async function stlOf(source: string) {
  const { csg } = await evaluateScad({ 'm.scad': source }, 'm.scad', openScad);
  return renderMesh(csg, openScad);
}

function asciiStl(binary: Uint8Array) {
  const { positions: p } = parseBinaryStl(binary);
  const lines = ['solid test'];
  for (let i = 0; i < p.length; i += 9) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (let k = 0; k < 3; k++) lines.push(`      vertex ${p[i + k * 3]} ${p[i + k * 3 + 1]} ${p[i + k * 3 + 2]}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid test');
  return new TextEncoder().encode(lines.join('\n'));
}

/** The swivel arm as the STEP file a person would download: four parts placed by two hinges and a slider. */
async function swivelStep() {
  const model = await build(swivelArm, 'swivel_arm.scad');
  const { meshes, assembly, partMesh } = model.preview;
  return {
    bytes: builder.exportStep(model),
    volume: meshes.reduce((sum, mesh) => sum + mesh.volume, 0),
    bounds: poseBounds(assembly, partMesh.map((i) => meshes[i].bounds)),
  };
}

test('a STEP of the swivel arm imports as one exact part with its four bodies', async () => {
  const arm = await swivelStep();
  const model = await build({}, 'arm.step', { 'arm.step': arm.bytes });
  const { meshes, assembly, isAssembly } = model.preview;
  assert.equal(isAssembly, false);
  assert.equal(meshes.length, 1);
  assert.equal(assembly.parts[0].name, 'arm');
  assert.equal(meshes[0].quality, 'exact');
  near(meshes[0].volume, arm.volume, arm.volume * 1e-4);
  const entry = model.entries[0];
  assert.equal(entry.kind, 'exact');
  assert.equal(kernel.subShapeCount(entry.shape, 'solid'), 4);
  // The parts keep the positions the hinges gave them.
  for (let k = 0; k < 3; k++) {
    near(meshes[0].bounds.min[k], arm.bounds.min[k], 0.05);
    near(meshes[0].bounds.max[k], arm.bounds.max[k], 0.05);
  }
  // A preview with faces, edges and corners the measure tool can number.
  assert.ok(meshes[0].indices.length > 300 && meshes[0].edgeSegments.length > 0 && meshes[0].corners.length > 0);
  assert.equal(meshes[0].faceOf.length, meshes[0].indices.length / 3);
});

test('an imported STEP is a part in an assembly, hinged to a part of OpenSCAD, and both survive STEP export', async () => {
  const arm = await swivelStep();
  const files = {
    'main.scad': `part("frame", "arm.step");
part("flap", "flap.scad", color = "#c0604c");
joint("hinge1", type = "hinge", parent = "frame", child = "flap", at = [100, 0, 0], axis = [0, 0, 1], limits = [-90, 90], value = 90);`,
    'flap.scad': 'cube([10, 10, 10]);',
  };
  const assets = { 'arm.step': arm.bytes };
  const model = await build(files, 'main.scad', assets);
  const { assembly, meshes, partMesh } = model.preview;
  assert.deepEqual(assembly.parts.map((part) => [part.name, part.file]), [['frame', 'arm.step'], ['flap', 'flap.scad']]);
  assert.deepEqual(partMesh.map((i) => meshes[i].quality), ['exact', 'exact']);

  // The hinge turns the cube 90 degrees about the vertical line through (100, 0): its x axis goes to +y, its y axis to -x.
  const m = solvePose(assembly, defaultPose(assembly))[1];
  const at = (x: number, y: number) => [m[0] * x + m[1] * y + m[3], m[4] * x + m[5] * y + m[7]];
  near(at(0, 0)[0], 100);
  near(at(0, 0)[1], 0);
  near(at(10, 0)[1], 10);
  near(at(0, 10)[0], 90);

  const step = builder.exportStep(model);
  const mark = kernel.checkpoint();
  const back = kernel.importStep(new TextDecoder().decode(step));
  assert.equal(kernel.subShapeCount(back, 'solid'), 5);
  near(kernel.getVolume(back), arm.volume + 1000, arm.volume * 1e-3);
  kernel.releaseSince(mark);

  // Building again with the same bytes reuses the solid; a part used twice shares it.
  const twice = await build({ ...files, 'main.scad': `${files['main.scad']}\npart("spare", "arm.step", at = [0, 200, 0]);` }, 'main.scad', assets);
  assert.equal(twice.preview.rebuilt, 0);
  assert.equal(twice.preview.partMesh[0], twice.preview.partMesh[2]);
});

test('a binary STL is a faceted part with the right volume, and STEP export sews it into a solid', async () => {
  const stl = await stlOf('cube([10, 20, 30]);');
  const model = await build({}, 'block.stl', { 'block.stl': stl });
  const mesh = model.preview.meshes[0];
  assert.equal(mesh.quality, 'faceted');
  assert.equal(mesh.reason, 'an imported STL mesh');
  near(mesh.volume, 6000, 1e-3);
  assert.equal(mesh.indices.length / 3, 12);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [10, 20, 30] });

  const step = builder.exportStep(model);
  const back = kernel.importStep(new TextDecoder().decode(step));
  near(kernel.getVolume(back), 6000, 0.01);
  assert.equal(kernel.subShapeCount(back, 'face'), 6);
});

test('a text STL reads the same as the binary one, and a mesh with its triangles inside out is turned around', async () => {
  const stl = await stlOf('cube([10, 20, 30]);');
  const text = await build({}, 'block.stl', { 'block.stl': asciiStl(stl) });
  near(text.preview.meshes[0].volume, 6000, 1e-3);

  const inside = toBinaryStl(flipTriangles(parseBinaryStl(stl)));
  assert.ok(meshVolume(parseBinaryStl(inside)) < 0);
  const turned = await build({}, 'inside.stl', { 'inside.stl': inside });
  near(turned.preview.meshes[0].volume, 6000, 1e-3);

  // Whichever way a file is written, parseStl gives the same triangles.
  assert.deepEqual([...parseStl(asciiStl(stl)).positions], [...parseBinaryStl(stl).positions]);
  assert.equal(assetFormat('motor.stl'), 'stl');
  assert.equal(assetFormat('motor.stp'), 'step');
  assert.equal(assetFormat('motor.STEP'), undefined);
});

test('import("m.stl") in a part file reads the project STL and is rebuilt only when the STL changes', async () => {
  const block = await stlOf('cube([10, 20, 30]);');
  const files = { 'part.scad': 'cube([10, 10, 10]); translate([20, 0, 0]) import("block.stl");' };
  const first = await build(files, 'part.scad', { 'block.stl': block });
  const mesh = first.preview.meshes[0];
  assert.equal(mesh.quality, 'faceted');
  assert.equal(mesh.reason, 'an imported STL mesh');
  near(mesh.volume, 7000, 1e-3);
  assert.deepEqual(mesh.bounds, { min: [0, 0, 0], max: [30, 20, 30] });

  const again = await build(files, 'part.scad', { 'block.stl': block });
  assert.equal(again.preview.rebuilt, 0);
  // The same bytes in another array are the same file.
  const copy = await build(files, 'part.scad', { 'block.stl': block.slice() });
  assert.equal(copy.preview.rebuilt, 0);

  const bigger = await stlOf('cube([10, 20, 40]);');
  const changed = await build(files, 'part.scad', { 'block.stl': bigger });
  assert.equal(changed.preview.rebuilt, 1);
  near(changed.preview.meshes[0].volume, 9000, 1e-3);

  // An imported part works inside braces too.
  const inline = await build({ 'main.scad': 'part("holder") { cube(5); translate([20, 0, 0]) import("block.stl"); }' }, 'main.scad', { 'block.stl': block });
  near(inline.preview.meshes[0].volume, 125 + 6000, 1e-3);
});

test('a file that cannot be used says what to change and names the file', async () => {
  const block = await stlOf('cube(10);');
  const rejected = async (files: ProjectFiles, entry: string, assets: ProjectAssets, pattern: RegExp, file: string, line?: number) => {
    await assert.rejects(build(files, entry, assets), (error: unknown) => {
      assert.ok(error instanceof CadError);
      assert.match(error.message, pattern);
      assert.equal(error.file, file, error.message);
      if (line !== undefined) assert.equal(error.line, line);
      return true;
    });
  };

  // A text file named .step.
  await rejected({}, 'notes.step', { 'notes.step': new TextEncoder().encode('These are my notes about the motor.') }, /is not a STEP file/, 'notes.step');
  // A STEP with nothing in it, and a STEP with a face and no solid.
  const empty = 'ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'\'),\'2;1\');\nFILE_NAME(\'\',\'\',(\'\'),(\'\'),\'\',\'\',\'\');\nFILE_SCHEMA((\'AUTOMOTIVE_DESIGN\'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
  await assert.rejects(build({}, 'empty.step', { 'empty.step': new TextEncoder().encode(empty) }), (error: unknown) => error instanceof CadError && error.file === 'empty.step' && /empty\.step/.test(error.message));
  const mark = kernel.checkpoint();
  const sheet = kernel.exportStep(kernel.getSubShapes(kernel.makeBox(10, 10, 10), 'face')[0], { unit: 'mm', schema: 'AP214' });
  kernel.releaseSince(mark);
  await rejected({}, 'sheet.step', { 'sheet.step': new TextEncoder().encode(sheet) }, /has no solid bodies\. It may contain only surfaces or curves/, 'sheet.step');
  // Not an STL, and an STL that does not close.
  await rejected({}, 'junk.stl', { 'junk.stl': new TextEncoder().encode('hello there, this is not a mesh at all'.repeat(4)) }, /could not be read\. This is not an STL file/, 'junk.stl');
  const flat = toBinaryStl({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  await rejected({}, 'flat.stl', { 'flat.stl': flat }, /does not enclose a volume/, 'flat.stl');
  // A mesh with a hole in it still shows, and says so.
  const holed = toBinaryStl({ positions: parseBinaryStl(block).positions.slice(0, 11 * 9) });
  const open = await build({}, 'open.stl', { 'open.stl': holed });
  assert.match(open.preview.meshes[0].reason!, /not closed \(3 open edges\)/);
  // One sentence says it, and the consequence follows once, not as a second "so" inside the reason.
  assert.equal(facetedText(open.preview), 'This solid is faceted because it uses an imported STL mesh that is not closed (3 open edges), so STEP has flat faces. A mesh that is not closed has no exact volume, and STEP export may fail.');

  // import() in a .scad file: STEP, a name that is not there, a name in a variable, a format OpenSCAD reads but this site does not.
  await rejected({ 'a.scad': 'cube(1);\nimport("motor.step");' }, 'a.scad', { 'motor.step': new TextEncoder().encode('x') }, /cannot read STEP files inside a model.*part\("name", "motor\.step"\)/, 'a.scad', 2);
  await rejected({ 'a.scad': 'import("missing.stl");' }, 'a.scad', {}, /missing\.stl is not in this project/, 'a.scad', 1);
  await rejected({ 'a.scad': 'f = "block.stl";\nimport(f);' }, 'a.scad', { 'block.stl': block }, /written out in quotes/, 'a.scad', 2);
  await rejected({ 'a.scad': 'import("shape.dxf");' }, 'a.scad', {}, /can only read an STL file that is in this project/, 'a.scad', 1);
  await rejected({ 'a.scad': 'surface(file = "x.dat");' }, 'a.scad', {}, /unavailable in this version/, 'a.scad', 1);
  // A part that names a native CAD file, or a file that is not in the project.
  await rejected({ 'main.scad': 'part("motor", "motor.sldprt");' }, 'main.scad', {}, /program's own format.*STEP version/, 'main.scad');
  await rejected({ 'main.scad': 'part("motor", "motor.step");' }, 'main.scad', {}, /motor\.step is not in this project/, 'main.scad');

  assert.match(unreadableFormat('motor.IGS')!, /IGES file.*STEP version/);
  assert.equal(unreadableFormat('motor.step'), undefined);
});

test('limits: one file up to 40 MB, all imported files up to 120 MB', async () => {
  const big = new Uint8Array(MAX_ASSET_BYTES + 1);
  await assert.rejects(build({}, 'big.stl', { 'big.stl': big }), /big\.stl is 40 MB\. One imported file can be up to 40 MB/);
  const piece = new Uint8Array(MAX_ASSET_BYTES - 1024 * 1024);
  const crowd = Object.fromEntries([1, 2, 3, 4].map((n) => [`piece${n}.stl`, piece]));
  await assert.rejects(build({}, 'piece1.stl', crowd), /imported files add up to .*A project can hold 120 MB of them/);
});

test('an imported STEP can be measured: a hole of the mounting plate reads diameter 5', async () => {
  const plate = examples.find((item) => item.name === 'Mounting plate')!;
  const original = await build({ [plate.filename]: plate.source }, plate.filename);
  const step = builder.exportStep(original);
  const model = await build({}, 'plate.step', { 'plate.step': step });
  const entry = model.entries[0];
  assert.equal(entry.kind, 'exact');
  const holes = kernel.getSubShapes(entry.shape, 'face').flatMap((shape, index) => kernel.surfaceData(shape).kind === 'cylinder' ? [index] : []);
  assert.equal(holes.length, 4);
  const result = builder.measure(model, defaultPose(model.assembly), [{ part: 0, type: 'face', index: holes[0] }]);
  const diameter = result.items[0].readings.find((reading) => reading.label === 'Diameter');
  assert.ok(diameter, JSON.stringify(result));
  near(diameter.value, 5, 1e-6);
});

test('an imported STL measures corners and areas, and a mesh part is never measured as exact', async () => {
  const stl = await stlOf('cube([10, 20, 30]);');
  const model = await build({}, 'block.stl', { 'block.stl': stl });
  const result = builder.measure(model, {}, [{ part: 0, type: 'face', index: model.preview.meshes[0].faceOf[0] }]);
  assert.equal(result.items[0].readings[0].label, 'Area');
  assert.ok(result.items[0].readings[0].value > 0);
});

test('a project zip keeps every file and every byte, and a version 1 project file still opens', async () => {
  const arm = await swivelStep();
  const stl = await stlOf('cube([10, 20, 30]);');
  const project: Project = {
    files: [
      { name: 'main.scad', source: 'part("frame", "arm.step");\npart("block", "block.stl");\n' },
      { name: 'arm.step', data: arm.bytes },
      { name: 'block.stl', data: stl },
      { name: 'notes.scad', source: '// été, ≥ 5 mm\ncube(1);\n' },
    ],
    active: 'arm.step',
    entry: 'main.scad',
  };
  const zip = serializeProjectZip(project);
  const back = readProjectZip(zip);
  assert.deepEqual(back.files.map((file) => file.name), ['main.scad', 'arm.step', 'block.stl', 'notes.scad']);
  assert.equal(back.active, 'arm.step');
  assert.equal(back.entry, 'main.scad');
  for (const [i, file] of project.files.entries()) {
    const read = back.files[i];
    assert.equal(isAsset(read), isAsset(file));
    if (isAsset(file) && isAsset(read)) assert.ok(Buffer.compare(file.data, read.data) === 0, `${file.name} changed`);
    else if (!isAsset(file) && !isAsset(read)) assert.equal(read.source, file.source);
  }
  assert.deepEqual(Object.keys(toFiles(back)), ['main.scad', 'notes.scad']);
  assert.deepEqual(Object.keys(toAssets(back)), ['arm.step', 'block.stl']);
  // What was reopened builds the same model.
  const model = await build(toFiles(back), 'main.scad', toAssets(back));
  assert.deepEqual(model.preview.assembly.parts.map((part) => part.file), ['arm.step', 'block.stl']);

  // A version 1 file holds text only and opens, whichever way it lists its files.
  const old = readProject(JSON.parse(serializeProject({ files: [{ name: 'a.scad', source: 'cube(1);' }], active: 'a.scad', entry: null })));
  assert.deepEqual(old, { files: [{ name: 'a.scad', source: 'cube(1);' }], active: 'a.scad', entry: null });
  assert.ok(readProject({ files: [{ name: 'a.scad', source: 'cube(1);' }, { name: 'arm.step', data: arm.bytes }], active: 'arm.step', entry: null }));
  // A draft saved before projects held one file.
  assert.equal(readProject({ source: 'cube(1);', filename: 'old design.scad' })?.files[0].name, 'old_design.scad');
  // Not a project.
  assert.equal(readProject({ files: [{ name: 'x.step', source: 'text' }] }), undefined);
  assert.equal(readProject({ files: [{ name: 'x.exe', data: new Uint8Array(3) }] }), undefined);
});

test('a project zip made by hand opens: inside a folder, with a readme, with no manifest; a bad one says why', () => {
  const zipped = zipSync({
    'my project/a.scad': strToU8('cube(1);'),
    'my project/motor.step': strToU8('ISO-10303-21;'),
    'my project/readme.txt': strToU8('hello'),
    '__MACOSX/._a.scad': strToU8('junk'),
  });
  const project = readProjectZip(zipped);
  assert.deepEqual(project.files.map((file) => file.name), ['a.scad', 'motor.step']);
  assert.equal(project.active, 'a.scad');
  assert.equal(project.entry, null);

  assert.throws(() => readProjectZip(new Uint8Array([1, 2, 3, 4])), /not a zip file that can be opened/);
  assert.throws(() => readProjectZip(zipSync({ 'readme.txt': strToU8('x') })), /holds no \.scad, \.step, \.stp or \.stl files/);
  assert.throws(() => readProjectZip(zipSync({ 'motor.sldprt': strToU8('x'), 'a.scad': strToU8('cube(1);') })), /program's own format.*STEP version/);
  assert.throws(() => readProjectZip(zipSync({ 'partscript.json': strToU8('{"format":"partscript-project","version":9}'), 'a.scad': strToU8('cube(1);') })), /newer version/);
  assert.throws(() => readProjectZip(zipSync({ 'partscript.json': strToU8('nope'), 'a.scad': strToU8('cube(1);') })), /partscript\.json in the zip is not readable/);
  assert.throws(() => readProjectZip(zipSync({ 'big.stl': new Uint8Array(MAX_ASSET_BYTES + 1) })), /big\.stl in the zip is 40 MB/);
});

test('names and limits on the page side', () => {
  assert.equal(assetFilename('NEMA 17 Motor.STEP'), 'NEMA_17_Motor.step');
  assert.equal(assetFilename('bracket.Stl'), 'bracket.stl');
  assert.equal(assetFilename('..hidden.STP'), 'hidden.stp');
  assert.equal(uniqueName('motor.step', ['motor.step', 'motor_2.step']), 'motor_3.step');
  assert.equal(uniqueName('part.scad', ['part.scad']), 'part_2.scad');
  assert.match(projectProblem([{ name: 'big.step', data: new Uint8Array(MAX_ASSET_BYTES + 1) }])!, /One imported file can be up to 40 MB/);
  assert.match(projectProblem(Array.from({ length: 41 }, (_, i) => ({ name: `f${i}.scad`, source: '' })))!, /A project can hold 40 files/);
  assert.equal(projectProblem([{ name: 'a.scad', source: 'cube(1);' }]), undefined);
});

test('a part with thousands of faces is meshed more coarsely, so a large import stays inside the job limit', () => {
  // A part of a few hundred faces keeps the fine setting that every part built here gets.
  assert.deepEqual(importedMeshing(120), { angular: 0.18, factor: 1 });
  assert.deepEqual(importedMeshing(400), { angular: 0.18, factor: 1 });
  assert.ok(importedMeshing(900).angular > 0.18 && importedMeshing(900).angular < importedMeshing(2_000).angular);
  assert.ok(importedMeshing(2_000).angular < importedMeshing(9_000).angular);
  assert.ok(importedMeshing(9_000).angular <= 1);
});

// --- Phase 10: a STEP assembly opens as separate parts ---

/** A base block and an arm that hinges at (40, 10, 5) about z. Worked by hand: the arm is 30 x 4 x 4 = 480 mm3, the base 40 x 20 x 10 = 8000. */
const hingeProject: ProjectFiles = {
  'hinge.scad': `part("base") { cube([40, 20, 10]); }
part("arm") { translate([0, -2, -2]) cube([30, 4, 4]); }
joint("h", type = "hinge", parent = "base", child = "arm", at = [40, 10, 5], axis = [0, 0, 1], limits = [0, 90], value = 0);`,
};

async function hingeStep(angle: number) {
  const model = await build(hingeProject, 'hinge.scad');
  return { model, bytes: builder.exportStep(model, { h: angle }) };
}

/** The box of a part's mesh points after its placement matrix. Exact for the points, unlike the box of the box. */
function worldBox(mesh: { positions: Float32Array }, m: number[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = m[k * 4] * p[i] + m[k * 4 + 1] * p[i + 1] + m[k * 4 + 2] * p[i + 2] + m[k * 4 + 3];
      min[k] = Math.min(min[k], v);
      max[k] = Math.max(max[k], v);
    }
  }
  return { min, max };
}

test('the swivel arm exported as STEP lists its four parts by name and colour, and each part has the volume of the original', async () => {
  const original = await build(swivelArm, 'swivel_arm.scad');
  const exported = builder.exportStep(original);
  const model = await build({}, 'swivel.step', { 'swivel.step': exported });
  const structure = model.preview.steps?.['swivel.step'];
  assert.ok(structure, 'the build reports what the STEP holds');
  assert.equal(structure.bodies, 4);
  const names = original.assembly.parts.map((part) => part.name);
  assert.deepEqual(structure.components.map((component) => component.path), names);
  structure.components.forEach((component, i) => {
    assert.equal(component.bodies, 1);
    assert.equal(component.firstBody, i + 1);
    assert.equal(component.depth, 0);
    const color = original.assembly.parts[i].color;
    assert.ok(component.color && component.color.every((v, k) => Math.abs(v - color[k]) < 1e-3), `${names[i]} keeps its colour`);
  });
  for (const [i, name] of names.entries()) {
    const part = await build({ 'a.scad': `part("p", "swivel.step", component = "${name}");` }, 'a.scad', { 'swivel.step': exported });
    const mesh = part.preview.meshes[0];
    const expected = original.preview.meshes[original.preview.partMesh[i]].volume;
    assert.ok(Math.abs(mesh.volume - expected) <= 0.001 * expected, `${name}: ${mesh.volume} against ${expected}`);
    assert.equal(mesh.bodies, 1);
    assert.equal(mesh.quality, 'exact');
  }
});

test('an assembly exported with the hinge at 30 degrees lists each component where the hinge put it', async () => {
  const { bytes } = await hingeStep(30);
  const model = await build({}, 'hinge.step', { 'hinge.step': bytes });
  const [base, arm] = model.preview.steps!['hinge.step'].components;
  assert.deepEqual([base.name, arm.name], ['base', 'arm']);
  // The base does not move.
  [0, 0, 0, 40, 20, 10].forEach((v, i) => near(i < 3 ? base.bounds.min[i] : base.bounds.max[i - 3], v, 1e-3));
  // The arm is 30 x 4 x 4 and turns 30 degrees about the vertical line through (40, 10). By hand, with c = cos 30 = 0.866025 and s = 0.5:
  // x runs from 40 - 2s = 39 to 40 + 30c + 2s = 66.98076; y from 10 - 2c = 8.26795 to 10 + 30s + 2c = 26.73205; z stays 3 to 7.
  near(arm.bounds.min[0], 39, 1e-3);
  near(arm.bounds.max[0], 40 + 30 * Math.cos(Math.PI / 6) + 1, 1e-3);
  near(arm.bounds.min[1], 10 - 2 * Math.cos(Math.PI / 6), 1e-3);
  near(arm.bounds.max[1], 10 + 15 + 2 * Math.cos(Math.PI / 6), 1e-3);
  near(arm.bounds.min[2], 3, 1e-3);
  near(arm.bounds.max[2], 7, 1e-3);
});

test('component and body pick one piece of the file, which keeps the position the file gives it', async () => {
  const { bytes } = await hingeStep(30);
  const assets = { 'hinge.step': bytes };
  const arm = await build({ 'a.scad': 'part("p", "hinge.step", component = "arm");' }, 'a.scad', assets);
  near(arm.preview.meshes[0].volume, 480, 0.01);
  const second = await build({ 'a.scad': 'part("p", "hinge.step", body = 2);' }, 'a.scad', assets);
  near(second.preview.meshes[0].volume, 480, 0.01);
  near(second.preview.meshes[0].bounds.max[0], 40 + 30 * Math.cos(Math.PI / 6) + 1, 1e-3);
  const first = await build({ 'a.scad': 'part("p", "hinge.step", body = 1);' }, 'a.scad', assets);
  near(first.preview.meshes[0].volume, 8000, 0.01);
  // at and rot apply on top of the position in the file.
  const moved = await build({ 'a.scad': 'part("p", "hinge.step", component = "arm", at = [0, 0, 100]);' }, 'a.scad', assets);
  const matrices = solvePose(moved.assembly, {});
  near(worldBox(moved.preview.meshes[0], matrices[0]).min[2], 103, 1e-3);
  // The whole file is still one part with both bodies.
  const whole = await build({ 'a.scad': 'part("p", "hinge.step");' }, 'a.scad', assets);
  near(whole.preview.meshes[0].volume, 8480, 0.01);
  assert.equal(whole.preview.meshes[0].bodies, 2);
});

test('a part that names a component or body the file does not have says what the file has', async () => {
  const { bytes } = await hingeStep(0);
  const assets = { 'hinge.step': bytes };
  await assert.rejects(build({ 'a.scad': 'part("p", "hinge.step", component = "plate");' }, 'a.scad', assets),
    (error: unknown) => error instanceof CadError && error.file === 'a.scad' && error.message === 'part("p"): hinge.step has no component "plate". It has: base, arm.');
  await assert.rejects(build({ 'a.scad': 'part("p", "hinge.step", body = 3);' }, 'a.scad', assets),
    (error: unknown) => error instanceof CadError && error.message === 'part("p"): hinge.step has 2 solid bodies. body can be 1 to 2.');
  await assert.rejects(build({ 'a.scad': 'part("p", "hinge.step", component = "arm", body = 1);' }, 'a.scad', assets),
    (error: unknown) => error instanceof CadError && error.message === 'part("p"): give component or body, not both.');
  await assert.rejects(build({ 'a.scad': 'part("p", "hinge.step", body = 0);' }, 'a.scad', assets),
    (error: unknown) => error instanceof CadError && /body is the number of a solid body/.test(error.message));
  await assert.rejects(build({ 'a.scad': 'part("p") { cube(5); }\npart("q", "arm.scad", component = "x");', 'arm.scad': 'cube(5);' }, 'a.scad'),
    (error: unknown) => error instanceof CadError && /component and body pick one part out of a STEP file, and arm.scad is not one/.test(error.message));
});

test('a file with one part and no structure lists no components, and body still works', async () => {
  const single = await build({ 'one.scad': 'cube([10, 20, 30]);' }, 'one.scad');
  const bytes = builder.exportStep(single);
  const model = await build({}, 'one.step', { 'one.step': bytes });
  const structure = model.preview.steps!['one.step'];
  assert.equal(structure.components.length, 0);
  assert.equal(structure.bodies, 1);
  const picked = await build({ 'a.scad': 'part("p", "one.step", body = 1);' }, 'a.scad', { 'one.step': bytes });
  near(picked.preview.meshes[0].volume, 6000, 0.01);
  await assert.rejects(build({ 'a.scad': 'part("p", "one.step", component = "x");' }, 'a.scad', { 'one.step': bytes }),
    (error: unknown) => error instanceof CadError && error.message === 'part("p"): one.step has no named components. Use body (only 1) to pick a solid body, or leave component out for the whole file.');
});

test('a component with components below it is named by its path, and its bodies are numbered in file order', async () => {
  // The swivel arm's STEP becomes one component, "inner", with four below it, moved 100 mm along x and turned 30 degrees,
  // so each part below it sits where its own place and its parent's place put it together. A block sits beside it.
  const arm = await build(swivelArm, 'swivel_arm.scad');
  const inner = builder.exportStep(arm);
  const nested = await build({ 'n.scad': 'part("block") { cube([10, 10, 10]); }\npart("inner", "swivel.step", at = [100, 0, 0], rot = [0, 0, 30]);' }, 'n.scad', { 'swivel.step': inner });
  const bytes = builder.exportStep(nested);
  const model = await build({}, 'nested.step', { 'nested.step': bytes });
  const { components, bodies } = model.preview.steps!['nested.step'];
  assert.equal(bodies, 5);
  assert.deepEqual(components.map((c) => c.path).slice(0, 2), ['block', 'inner']);
  const below = components.filter((c) => c.depth === 1);
  assert.equal(below.length, 4);
  assert.ok(below.every((c) => c.path.startsWith('inner/')), 'the parts below inner are named by their path');
  assert.equal(new Set(components.map((c) => c.path)).size, components.length, 'every path is different');
  const innerRow = components.find((c) => c.path === 'inner')!;
  assert.equal(innerRow.bodies, 4);
  assert.equal(innerRow.firstBody, 2);
  const total = arm.preview.meshes.reduce((sum, mesh) => sum + mesh.volume, 0);
  const wholeInner = await build({ 'a.scad': 'part("p", "nested.step", component = "inner");' }, 'a.scad', { 'nested.step': bytes });
  assert.ok(Math.abs(wholeInner.preview.meshes[0].volume - total) <= 0.001 * total);
  assert.equal(wholeInner.preview.meshes[0].bodies, 4);
  // The third part of the arm, picked by path, has its volume and sits where the file puts it.
  const third = below[2];
  const one = await build({ 'a.scad': `part("p", "nested.step", component = "${third.path}");` }, 'a.scad', { 'nested.step': bytes });
  const byBody = await build({ 'a.scad': `part("p", "nested.step", body = ${third.firstBody});` }, 'a.scad', { 'nested.step': bytes });
  near(one.preview.meshes[0].volume, byBody.preview.meshes[0].volume, 0.01);
  // Picked by path, by body number (the kernel's own placement of every solid) and as listed: the same box.
  [0, 1, 2].forEach((k) => {
    near(one.preview.meshes[0].bounds.min[k], byBody.preview.meshes[0].bounds.min[k], 1e-3);
    near(one.preview.meshes[0].bounds.max[k], byBody.preview.meshes[0].bounds.max[k], 1e-3);
    near(third.bounds.min[k], byBody.preview.meshes[0].bounds.min[k], 1e-3);
    near(third.bounds.max[k], byBody.preview.meshes[0].bounds.max[k], 1e-3);
  });
  assert.ok(byBody.preview.meshes[0].bounds.min[0] > 50, 'the part moved with its parent, so it is nowhere near the origin');
});

test('the round trip: export an assembly, open it as two parts with the same hinge, and every pose matches the original', async () => {
  // Exported with the hinge at 0, the arm sits in the file at (40, 10, 5) and the base where it was.
  const { model: original, bytes } = await hingeStep(0);
  const assets = { 'hinge.step': bytes };
  const reopened = await build({
    'again.scad': `part("base", "hinge.step", component = "base");
part("arm", "hinge.step", component = "arm");
// The arm's solid already sits at the hinge, so the hinge point is the same in both parts.
joint("h", type = "hinge", parent = "base", child = "arm", at = [40, 10, 5], child_at = [40, 10, 5], axis = [0, 0, 1], limits = [0, 90], value = 0);`,
  }, 'again.scad', assets);
  for (const angle of [0, 15, 30, 90]) {
    const before = solvePose(original.assembly, { h: angle });
    const after = solvePose(reopened.assembly, { h: angle });
    for (let i = 0; i < 2; i++) {
      const a = worldBox(original.preview.meshes[original.preview.partMesh[i]], before[i]);
      const b = worldBox(reopened.preview.meshes[reopened.preview.partMesh[i]], after[i]);
      for (let k = 0; k < 3; k++) {
        near(b.min[k], a.min[k], 1e-4);
        near(b.max[k], a.max[k], 1e-4);
      }
    }
  }
  // Hand check at 90 degrees: the arm's far end, 30 mm along its length, is at (40, 40, 5), so its box reaches y = 10 + 30 + 0 = 40 and x from 38 to 42.
  const turned = worldBox(reopened.preview.meshes[reopened.preview.partMesh[1]], solvePose(reopened.assembly, { h: 90 })[1]);
  near(turned.max[1], 40, 1e-4);
  near(turned.min[0], 38, 1e-4);
  near(turned.max[0], 42, 1e-4);
});

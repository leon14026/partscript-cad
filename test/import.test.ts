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

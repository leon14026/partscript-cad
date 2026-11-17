import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { ModelBuilder } from '../src/engine/build.ts';
import { CadError } from '../src/engine/protocol.ts';
import type { OpenScadFactory } from '../src/engine/scad.ts';
import { loadLibrary } from './libraries.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const kernel = await OcctKernel.init();
const output = new URL('../.test-output/', import.meta.url);
await mkdir(output, { recursive: true });

after(() => kernel.releaseAll());

/** A builder that counts OpenSCAD runs and library fetches, so a test can say how many a build took. */
function counted(withLoader = true) {
  const count = { runs: 0, fetches: 0 };
  const openScad: OpenScadFactory = (options) => {
    count.runs++;
    return instantiate({ ...options, wasmBinary: wasm });
  };
  const loader = withLoader ? (name: string) => { count.fetches++; return loadLibrary(name); } : undefined;
  return { count, builder: new ModelBuilder(kernel, openScad, loader) };
}

function near(actual: number, expected: number, relative = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= relative * Math.abs(expected), `Expected ${expected}, received ${actual}`);
}

const header = 'include <BOSL2/std.scad>\ninclude <BOSL2/gears.scad>\n';

// spur_gear(mod = m, teeth = n): pitch radius m n / 2, tip radius one module further out, root radius 1.25 modules in.
const radii = (mod: number, teeth: number) => ({ pitch: mod * teeth / 2, tip: mod * teeth / 2 + mod, root: mod * teeth / 2 - 1.25 * mod });
const cylinder = (r: number, h: number) => Math.PI * r * r * h;

test('a BOSL2 spur gear builds exact, as a prism of its tooth outline, with a volume between its root and tip cylinders', async () => {
  const { builder } = counted();
  const model = await builder.build({ 'gear.scad': `${header}spur_gear(mod = 2, teeth = 20, thickness = 8);` }, 'gear.scad');
  const [mesh] = model.preview.meshes;
  const { pitch, tip, root } = radii(2, 20);
  assert.deepEqual([root, pitch, tip], [17.5, 20, 22]);
  assert.equal(mesh.quality, 'exact');
  assert.ok(mesh.volume > cylinder(root, 8) && mesh.volume < cylinder(tip, 8), `volume ${mesh.volume}`);
  // Rough hand estimate: tooth and space are about equal at the pitch circle, so the area is
  // near the pitch circle's, less the extra 0.25 module of root clearance over half its circumference.
  const estimate = (Math.PI * pitch ** 2 - 0.5 * 0.25 * 2 * (2 * Math.PI * pitch)) * 8;
  near(mesh.volume, estimate, 0.03);
  // Eight thick, centred on z. Tips are 18 degrees apart, so one lies within 9 degrees of each axis.
  near(mesh.bounds.min[2], -4, 1e-4);
  near(mesh.bounds.max[2], 4, 1e-4);
  for (let axis = 0; axis < 2; axis++) {
    assert.ok(mesh.bounds.max[axis] <= tip + 1e-3 && mesh.bounds.max[axis] >= tip * Math.cos(9 * Math.PI / 180), `reach ${mesh.bounds.max[axis]}`);
    assert.ok(mesh.bounds.min[axis] >= -tip - 1e-3 && mesh.bounds.min[axis] <= -tip * Math.cos(9 * Math.PI / 180));
  }

  // The exact part exports as one solid.
  const bytes = builder.exportStep(model);
  await writeFile(new URL('bosl2_gear.step', output), bytes);
  const mark = kernel.checkpoint();
  const shape = kernel.importStep(new TextDecoder().decode(bytes));
  assert.equal(kernel.subShapeCount(shape, 'solid'), 1);
  near(kernel.getVolume(shape), mesh.volume, 1e-3);
  kernel.releaseSince(mark);
});

test('inline parts that use BOSL2 take one run to evaluate and one to mesh each, and fetch the library once', async () => {
  const { builder, count } = counted();
  const model = await builder.build({
    'train.scad': `${header}
      part("gear") spur_gear(mod = 2, teeth = 20, thickness = 8);
      part("pinion", at = [30, 0, 0]) spur_gear(mod = 2, teeth = 10, thickness = 8);`,
  }, 'train.scad');
  assert.equal(count.fetches, 1);
  assert.equal(count.runs, 3);
  assert.equal(model.preview.assembly.parts.length, 2);
  const volumes = model.preview.partMesh.map((index) => model.preview.meshes[index].volume);
  for (const [i, teeth] of [20, 10].entries()) {
    const { root, tip } = radii(2, teeth);
    assert.ok(volumes[i] > cylinder(root, 8) && volumes[i] < cylinder(tip, 8), `${teeth} teeth: volume ${volumes[i]}`);
  }
});

test('a part file that uses BOSL2 builds when the main file does not mention the library itself', async () => {
  const { builder, count } = counted();
  const model = await builder.build({
    'gear.scad': `${header}spur_gear(mod = 1.5, teeth = 16, thickness = 5);`,
    'main.scad': 'part("g", "gear.scad");',
  }, 'main.scad');
  assert.equal(count.fetches, 1);
  assert.equal(count.runs, 3); // main, gear.scad, and the mesh of the gear
  const { root, tip } = radii(1.5, 16);
  const volume = model.preview.meshes[0].volume;
  assert.ok(volume > cylinder(root, 5) && volume < cylinder(tip, 5), `volume ${volume}`);
});

test('a project that includes no library never fetches one', async () => {
  const { builder, count } = counted();
  await builder.build({ 'cube.scad': 'cube(5);' }, 'cube.scad');
  assert.equal(count.fetches, 0);
});

test('without a loader the BOSL2 include says so by name', async () => {
  const { builder } = counted(false);
  await assert.rejects(builder.build({ 'gear.scad': `${header}spur_gear(mod = 2, teeth = 20, thickness = 8);` }, 'gear.scad'), /BOSL2 cannot be loaded/);
});

test('a library other than BOSL2 is refused with the line, the file and a way forward', async () => {
  const { builder } = counted();
  for (const source of ['cube(1);\ninclude <MCAD/boxes.scad>\ncube(2);', 'cube(1);\nuse <MCAD/boxes.scad>\ncube(2);']) {
    await assert.rejects(builder.build({ 'main.scad': source }, 'main.scad'), (error: unknown) => {
      assert.ok(error instanceof CadError);
      assert.match(error.message, /External libraries are unavailable in this version except BOSL2/);
      assert.match(error.message, /MCAD\/boxes\.scad is not one of them/);
      assert.equal(error.line, 2);
      assert.equal(error.file, 'main.scad');
      return true;
    });
  }
});

test('a BOSL2 file that does not exist is named, with the line', async () => {
  const { builder } = counted();
  for (const word of ['include', 'use']) {
    await assert.rejects(builder.build({ 'main.scad': `cube(1);\n${word} <BOSL2/nonsense.scad>\ncube(2);` }, 'main.scad'), (error: unknown) => {
      assert.ok(error instanceof CadError);
      assert.match(error.message, /^BOSL2\/nonsense\.scad is not a file in BOSL2\. Check the spelling/);
      assert.equal(error.line, 2);
      assert.equal(error.file, 'main.scad');
      return true;
    });
  }
});

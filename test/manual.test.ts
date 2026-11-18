import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { OcctKernel } from 'occt-wasm';
import { codeBlocks, renderBody, renderManual, cells, type CodeBlock } from '../scripts/manual.ts';
import { overlapFloor, sampleMove, touchDepth } from '../src/collision.ts';
import { assemblyPrelude } from '../src/engine/assembly.ts';
import { ModelBuilder } from '../src/engine/build.ts';
import { maxLeaves } from '../src/engine/flat.ts';
import { JOB_TIMEOUT_MS, MAX_ASSET_BYTES, MAX_ASSETS_BYTES, MAX_PROJECT_BYTES, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type ProjectAssets, type ProjectFiles } from '../src/engine/protocol.ts';
import { evaluateScad, renderMesh, type OpenScadFactory } from '../src/engine/scad.ts';
import { facetedText, flatRoundNotes } from '../src/engine/summary.ts';
import { gearedMechanism } from '../src/gearedExample.ts';
import { loadLibrary } from './libraries.ts';

const engine = new URL('../public/engines/openscad/openscad.js', import.meta.url);
const wasm = await readFile(new URL('openscad.wasm', engine));
const { default: instantiate } = await import(engine.href);
const openScad: OpenScadFactory = (options) => instantiate({ ...options, wasmBinary: wasm });
const kernel = await OcctKernel.init();
const builder = new ModelBuilder(kernel, openScad, loadLibrary);

after(() => kernel.releaseAll());

const markdown = await readFile(new URL('../docs/MANUAL.md', import.meta.url), 'utf8');
const blocks = codeBlocks(markdown);

test('the manual has its thirteen sections, in order', () => {
  const titles = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(titles, [
    '1. Getting started',
    '2. OpenSCAD in ten minutes',
    '3. Parts',
    '4. Joints',
    '5. Linkages and driven joints',
    '6. Several files',
    '7. Importing STEP and STL files',
    '8. Measure',
    '9. Collisions',
    '10. Exact and faceted',
    '11. When something goes wrong',
    '12. Limits',
    '13. Cheat sheet',
  ]);
});

test('the manual renders to a page: thirteen sections, a contents list that links to them, and no Markdown left over', () => {
  const page = renderManual(markdown);
  assert.equal((page.match(/<h2 /g) ?? []).length, 13);
  const { html, headings } = renderBody(markdown);
  const ids = new Set(headings.map((heading) => heading.id));
  const links = [...page.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.equal(links.length, 13);
  for (const id of links) assert.ok(ids.has(id), `The contents list links to #${id}, which is not a heading.`);
  assert.equal(ids.size, headings.length, 'Two headings have the same id.');
  // Outside the code blocks nothing of the Markdown should show through.
  const text = html.replace(/<pre>[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '').replace(/<[^>]+>/g, ' ');
  for (const left of ['**', '`', '](', '| ---']) assert.ok(!text.includes(left), `The page shows "${left}" as text.`);
  assert.ok(page.includes('href="./"'), 'The page should link back to the editor.');
});

test('the renderer refuses Markdown it cannot draw instead of drawing it wrong', () => {
  assert.throws(() => renderBody('> a quote'), /does not draw/);
  assert.throws(() => renderBody('- one\n  - nested'), /does not draw/);
  assert.throws(() => renderBody('| a | b |\n| 1 | 2 |'), /no header separator/);
  assert.throws(() => renderBody('| a | b |\n| --- | --- |\n| 1 |'), /1 cells instead of 2/);
  assert.throws(() => renderBody('```scad\ncube(1);'), /never closed/);
  assert.deepEqual(cells('| `a | b` | c |'), ['`a | b`', 'c']);
});

// part() and joint() are read by assembly.ts from the module signatures in assemblyPrelude, so those are what the manual must match.
function prelude(module: 'part' | 'joint') {
  const signature = new RegExp(`module ${module}\\(([^)]*)\\)`).exec(assemblyPrelude)![1];
  return signature.split(/,\s*(?![^[]*\])/).map((item) => {
    const [name, value] = item.split(/\s*=\s*/);
    return { name: name.trim(), value: value?.trim() };
  });
}

/** The rows of the first table of the section's heading `after` whose first cell is a single `name`. */
function rowsAfter(after: string) {
  const start = markdown.indexOf(after);
  assert.ok(start >= 0, `${after} is not in the manual.`);
  const rows = new Map<string, string[]>();
  for (const line of markdown.slice(start).split('\n').slice(1)) {
    if (!line.startsWith('|')) {
      if (rows.size) break;
      continue;
    }
    const row = cells(line);
    const name = /^`([a-z_]+)`$/.exec(row[0])?.[1];
    if (name) rows.set(name, row);
  }
  return rows;
}

for (const module of ['part', 'joint'] as const) {
  test(`the ${module}() signature and argument table match the module in assembly.ts`, () => {
    const arguments_ = prelude(module);
    const signature = markdown.match(new RegExp(`^${module}\\(([^)]*)\\)$`, 'm'))?.[1];
    assert.ok(signature, `The manual has no ${module}(...) signature line.`);
    assert.deepEqual(signature.split(/,\s*/).map((name) => name.trim()), arguments_.map((item) => item.name));
    const rows = rowsAfter(module === 'part' ? '| Argument | Meaning | Default |\n| --- | --- | --- |\n| `name` | The part' : '| Argument | Meaning | Unit | Default |\n| --- | --- | --- | --- |\n| `name` | The joint');
    for (const { name, value } of arguments_) {
      // follow, ratio, offset and table have their own table in section 5.
      if (module === 'joint' && ['follow', 'ratio', 'offset', 'table'].includes(name)) continue;
      const row = rows.get(name);
      assert.ok(row, `The ${module}() table has no row for ${name}.`);
      if (value && value !== 'undef') assert.ok(row.at(-1)!.includes(value), `The default of ${module}(${name}) is ${value}, and the table says: ${row.at(-1)}`);
    }
    for (const name of rows.keys()) assert.ok(arguments_.some((item) => item.name === name), `The ${module}() table lists ${name}, which assembly.ts does not read.`);
  });
}

test('the allow_overlap() signature, and the numbers the collision section gives, match the code', () => {
  const arguments_ = /module allow_overlap\(([^)]*)\)/.exec(assemblyPrelude)![1].split(',').map((item) => item.split('=')[0].trim());
  const signature = markdown.match(/^allow_overlap\(([^)]*)\)$/m)?.[1];
  assert.ok(signature, 'The manual has no allow_overlap(...) signature line.');
  assert.deepEqual(signature.split(/,\s*/).map((name) => name.trim()), arguments_);
  const section = markdown.slice(markdown.indexOf('## 9. Collisions'), markdown.indexOf('## 10. Exact and faceted'));
  assert.ok(section.includes(`every ${sampleMove} mm that any point`), 'The section should give the sweep step in mm.');
  assert.ok(section.includes(`shallower than ${touchDepth} mm`) && section.includes(`smaller than ${overlapFloor} mm³`), 'The section should give the depth and the volume that count as touching.');
});

test('the follow table lists the arguments assembly.ts reads, with their defaults', () => {
  const rows = rowsAfter('| Argument | Meaning | Default |\n| --- | --- | --- |\n| `follow` | The name of the joint to follow');
  assert.deepEqual([...rows.keys()], ['follow', 'ratio', 'offset', 'table']);
  assert.ok(rows.get('ratio')!.at(-1)!.includes('1') && rows.get('offset')!.at(-1)!.includes('0'));
});

test('the limits table matches the numbers in the code', () => {
  const limits = new Map(markdown.split('\n').filter((line) => line.startsWith('| ')).map((line) => cells(line)).map((row) => [row[0], row[1]]));
  assert.equal(limits.get('Files in a project'), String(MAX_PROJECT_FILES));
  assert.equal(limits.get('One text file'), `${MAX_SOURCE_BYTES / 1024} KiB`);
  assert.equal(limits.get('All text files together'), `${MAX_PROJECT_BYTES / 1024 / 1024} MiB`);
  assert.equal(limits.get('One imported file'), `${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  assert.equal(limits.get('All imported files together'), `${MAX_ASSETS_BYTES / 1024 / 1024} MB`);
  assert.equal(limits.get('Pieces in one extrusion'), String(maxLeaves));
  assert.equal(limits.get('Time for one build'), `${JOB_TIMEOUT_MS / 1000} seconds`);
});

// The code blocks. A block marked `scad` is built, `scad error` must fail with the message in the block after it, and `scad says`
// must give the build output in the block after it. Blocks with the same project=name are the files of one project: file=name.scad
// says which file a block is (design.scad when it does not), and `entry` marks the file that is built (the first one otherwise).
// `assets` adds a motor.step and a bracket.stl to the project, and `assembly` also adds fixture.step, an exported assembly. `same-as=name` makes the block equal an example of the site.
const scad = blocks.filter((block) => block.language === 'scad');

test('the manual has examples of each kind', () => {
  assert.ok(scad.length >= 40, `Only ${scad.length} examples.`);
  assert.ok(scad.some((block) => block.attributes.has('error')) && scad.some((block) => block.attributes.has('says')) && scad.some((block) => block.attributes.has('assets')));
  for (const block of blocks) assert.ok(['scad', 'text'].includes(block.language), `Line ${block.line}: the code block language is ${block.language}.`);
});

async function assetsOf(): Promise<ProjectAssets> {
  const motor = await builder.build({ 'm.scad': 'cylinder(h = 40, d = 36);' }, 'm.scad');
  const { csg } = await evaluateScad({ 'b.scad': 'cube([30, 20, 5]);' }, 'b.scad', openScad);
  return { 'motor.step': builder.exportStep(motor), 'bracket.stl': await renderMesh(csg, openScad) };
}
const assets = await assetsOf();
// `assembly` adds fixture.step, a plate 60 x 40 x 6 and a post (a 8 mm cylinder, 20 mm tall) exported as two parts.
const fixture = await builder.build({ 'f.scad': 'part("plate", color = "#8d99a6") cube([60, 40, 6]);\npart("post", color = "#c0604c") { translate([30, 20, 6]) cylinder(h = 20, d = 8); }' }, 'f.scad');
const assemblyAssets: ProjectAssets = { ...assets, 'fixture.step': builder.exportStep(fixture) };

/** The files of the project that a block belongs to, and which file is built. */
function projectOf(block: CodeBlock) {
  const name = block.attributes.get('project');
  const members = typeof name === 'string' ? scad.filter((other) => other.attributes.get('project') === name) : [block];
  const files: ProjectFiles = {};
  let entry: string | undefined;
  for (const member of members) {
    const file = typeof member.attributes.get('file') === 'string' ? member.attributes.get('file') as string : 'design.scad';
    files[file] = member.code;
    if (member.attributes.has('entry')) entry = file;
  }
  return { files, entry: entry ?? Object.keys(files)[0] };
}

for (const block of scad) {
  const next = blocks[blocks.indexOf(block) + 1];
  const label = `manual line ${block.line}: ${block.code.split('\n').find((line) => line.trim() && !line.startsWith('//'))?.trim().slice(0, 60)}`;
  const { files, entry } = projectOf(block);
  const used = block.attributes.has('assembly') ? assemblyAssets : block.attributes.has('assets') ? assets : {};
  // Only the block that closes a project builds it.
  const name = block.attributes.get('project');
  const last = typeof name !== 'string' || scad.filter((other) => other.attributes.get('project') === name).at(-1) === block;
  if (!last) continue;

  if (block.attributes.has('error')) {
    test(`${label} fails with the message printed under it`, async () => {
      assert.equal(next?.language, 'text', 'An error example needs a text block with its message right after it.');
      await assert.rejects(builder.build(files, entry, undefined, used), (error: Error) => {
        assert.equal(error.message, next.code.trim());
        return true;
      });
    });
  } else if (block.attributes.has('says')) {
    test(`${label} makes the build output printed under it`, async () => {
      assert.equal(next?.language, 'text', 'A says example needs a text block with the output right after it.');
      const { preview } = await builder.build(files, entry, undefined, used);
      const notes = flatRoundNotes(preview, files, entry);
      const said = [facetedText(preview), ...notes.errors, ...notes.logs].filter(Boolean).join('\n');
      assert.equal(said, next.code.trim());
    });
  } else {
    test(`${label} builds`, async () => {
      const { preview } = await builder.build(files, entry, undefined, used);
      assert.ok(preview.meshes.length > 0 && preview.meshes.every((mesh) => mesh.volume > 0));
      const same = block.attributes.get('same-as');
      if (typeof same === 'string') assert.equal(block.code.trim(), gearedMechanism[same].trim(), `The manual's ${same} differs from the example the site ships.`);
    });
  }
}

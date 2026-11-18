import assert from 'node:assert/strict';
import test from 'node:test';
import { addFiles, projectProblem, type ProjectFile } from '../src/project.ts';

const text = (name: string, source = `// ${name}`): ProjectFile => ({ name, source });
const names = (files: ProjectFile[]) => files.map((file) => file.name);

test('adding a file to a project with one file keeps that file, which Open would have replaced', () => {
  const existing = [text('part.scad', 'cube(10);')];
  const { files, added, renamed } = addFiles(existing, [text('bracket.scad', 'cube(5);')]);
  assert.deepEqual(names(files), ['part.scad', 'bracket.scad']);
  assert.deepEqual(names(added), ['bracket.scad']);
  assert.deepEqual(renamed, []);
  assert.equal(files[0], existing[0], 'the file that was there is the same object, not a copy with new text');
  assert.equal((files[0] as { source: string }).source, 'cube(10);');
});

test('a name that is taken is not overwritten: the new file is arm_2.scad and the old arm.scad is untouched', () => {
  const existing = [text('main.scad', 'part("a", "arm.scad");'), text('arm.scad', 'cube([40, 8, 8]);')];
  const { files, added, renamed } = addFiles(existing, [text('arm.scad', 'cube([99, 9, 9]);')]);
  assert.deepEqual(names(files), ['main.scad', 'arm.scad', 'arm_2.scad']);
  assert.deepEqual(renamed, [{ from: 'arm.scad', to: 'arm_2.scad' }]);
  assert.equal((files[1] as { source: string }).source, 'cube([40, 8, 8]);');
  assert.equal((added[0] as { source: string }).source, 'cube([99, 9, 9]);');
});

test('several files at once: two with one name keep both, and a name that already ends in _2 moves on to _2_2', () => {
  const { files, renamed } = addFiles([text('arm.scad')], [text('arm.scad'), text('arm.scad'), text('arm_2.scad')]);
  // arm.scad is taken, so the first becomes arm_2.scad and the second arm_3.scad. The third asks for arm_2.scad, which the first now holds.
  assert.deepEqual(names(files), ['arm.scad', 'arm_2.scad', 'arm_3.scad', 'arm_2_2.scad']);
  assert.deepEqual(renamed, [
    { from: 'arm.scad', to: 'arm_2.scad' },
    { from: 'arm.scad', to: 'arm_3.scad' },
    { from: 'arm_2.scad', to: 'arm_2_2.scad' },
  ]);
});

test('an imported file keeps its bytes, and a second motor.step does not replace the first', () => {
  const first = new Uint8Array([1, 2, 3]);
  const second = new Uint8Array([4, 5, 6, 7]);
  const existing: ProjectFile[] = [text('main.scad'), { name: 'motor.step', data: first }];
  const { files, added } = addFiles(existing, [{ name: 'motor.step', data: second }]);
  assert.deepEqual(names(files), ['main.scad', 'motor.step', 'motor_2.step']);
  assert.equal((files[1] as { data: Uint8Array }).data, first);
  assert.equal((added[0] as { data: Uint8Array }).data, second);
});

test('the lists that were passed in are not changed', () => {
  const existing = [text('a.scad')];
  const incoming = [text('a.scad'), text('b.scad')];
  addFiles(existing, incoming);
  assert.deepEqual(names(existing), ['a.scad']);
  assert.deepEqual(names(incoming), ['a.scad', 'b.scad']);
});

test('the limit of 40 files still applies: the 41st file is refused in the usual words', () => {
  const full = Array.from({ length: 40 }, (_, i) => text(`f${i}.scad`));
  assert.equal(projectProblem(addFiles(full, []).files), undefined);
  assert.equal(projectProblem(addFiles(full, [text('one_more.scad')]).files), 'A project can hold 40 files.');
});

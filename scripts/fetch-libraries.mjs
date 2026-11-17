// Builds public/engines/libraries/BOSL2.zip from the pinned commit of BOSL2.
//
//   node scripts/fetch-libraries.mjs
//
// The zip is committed, so building and testing the site needs no network.
// Run this only to change the pinned commit: edit `commit` below, run the
// script, update public/licenses/NOTICES.txt to the same hash, and commit both.
//
// It uses git rather than a GitHub archive link because git reads work wherever
// GitHub is reachable at all. The zip holds the top-level *.scad files and the
// LICENSE of BOSL2, which is all that `include <BOSL2/std.scad>` needs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const repository = 'https://github.com/BelfrySCAD/BOSL2';
const commit = 'ca677d0cf7a70fdd302dcbdb622e074ac2eaa5b3';
const output = fileURLToPath(new URL('../public/engines/libraries/BOSL2.zip', import.meta.url));

const work = mkdtempSync(join(tmpdir(), 'bosl2-'));
try {
  const git = (...args) => execFileSync('git', ['-C', work, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  git('init', '--quiet');
  git('fetch', '--quiet', '--depth', '1', repository, commit);
  git('checkout', '--quiet', 'FETCH_HEAD');
  if (git('rev-parse', 'HEAD') !== commit) throw new Error(`Fetched ${git('rev-parse', 'HEAD')}, expected ${commit}.`);

  const names = readdirSync(work, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.scad') || entry.name === 'LICENSE'))
    .map((entry) => entry.name)
    .sort();
  if (!names.includes('std.scad') || !names.includes('LICENSE')) throw new Error('std.scad or LICENSE is missing from the checkout.');

  const files = Object.fromEntries(names.map((name) => [name, readFileSync(join(work, name))]));
  // A fixed time makes the zip identical on every run, so a change in git means a real change.
  const zip = zipSync(files, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, zip);
  console.log(`BOSL2 ${commit.slice(0, 9)}: ${names.length} files, ${(zip.length / 1048576).toFixed(2)} MiB -> ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

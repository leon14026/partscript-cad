import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const archive = {};
const releasePaths = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'README.md', 'LICENSE', '.gitignore', '.github', 'public', 'src', 'scripts', 'test'];

async function add(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (entries) {
    for (const entry of entries) await add(`${path}/${entry.name}`);
  } else {
    archive[`partscript-cad/${path}`] = await readFile(path);
  }
}

for (const path of releasePaths) await add(path);
await mkdir('dist/source', { recursive: true });
await writeFile('dist/source/partscript-cad-source.zip', zipSync(archive, { level: 6 }));

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || info.dev) continue;
  const name = path.split('node_modules/').at(-1);
  const files = await readdir(path);
  const texts = files.filter((file) => /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9]+)?$/i.test(file));
  for (const file of texts) notices.push(`${name} ${info.version} (${file})\n\n${await readFile(join(path, file), 'utf8')}`);
}

await copyFile('LICENSE', 'dist/licenses/GPL-3.0.txt');
await writeFile('dist/licenses/npm-licenses.txt', notices.join('\n\n----------------------------------------\n\n'));

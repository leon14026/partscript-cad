// Writes public/manual.html from docs/MANUAL.md. `npm run dev` and `npm run build` run it first, and Vite then serves or copies the page.
import { readFile, writeFile } from 'node:fs/promises';
import { renderManual } from './manual.ts';

const markdown = await readFile(new URL('../docs/MANUAL.md', import.meta.url), 'utf8');
await writeFile(new URL('../public/manual.html', import.meta.url), renderManual(markdown));

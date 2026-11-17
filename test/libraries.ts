import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { libraries, type LibraryFiles, type LibraryLoader } from '../src/engine/scad.ts';

const cache = new Map<string, Promise<LibraryFiles>>();

/** The same zips the site serves, read from public/ instead of fetched. */
export const loadLibrary: LibraryLoader = (name) => {
  if (!Object.hasOwn(libraries, name)) throw new Error(`${name} is not a library`);
  let loaded = cache.get(name);
  if (!loaded) {
    loaded = readFile(new URL(`../public/${libraries[name as keyof typeof libraries]}`, import.meta.url))
      .then((bytes) => unzipSync(new Uint8Array(bytes)));
    cache.set(name, loaded);
  }
  return loaded;
};

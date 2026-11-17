import { assemblyPrelude, fileNamePattern, recordMarker } from './assembly.ts';
import { CadError, MAX_PROJECT_BYTES, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type ProjectFiles } from './protocol.ts';

export interface OpenScadModule {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, data: string | Uint8Array): void;
    mkdir(path: string): void;
    readFile(path: string, options: { encoding: 'utf8' }): string;
    readFile(path: string): Uint8Array;
  };
}

export type OpenScadFactory = (options: {
  noInitialRun: true;
  /** The engine's bytes. Pass them to skip downloading openscad.wasm again for every run. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<OpenScadModule>;

/**
 * Libraries a project can include as `<Name/file.scad>`. Each is a zip of files
 * served with the site and loaded the first time a build needs it. Add one by
 * putting its zip next to BOSL2.zip, listing it here, and crediting it in
 * public/licenses/NOTICES.txt.
 */
export const libraries = { BOSL2: 'engines/libraries/BOSL2.zip' } as const;

/** One library's files, by file name. */
export type LibraryFiles = Record<string, Uint8Array>;
/** Fetches a library by name. The loader keeps what it has fetched, so asking again is cheap. */
export type LibraryLoader = (name: string) => Promise<LibraryFiles>;

const csgPath = '/partscript-output.csg';
const meshInput = '/part.csg';
const meshOutput = '/part.stl';
const maxRecords = 1_000;

function lineOf(code: string, index: number) {
  return code.slice(0, index).split(/\r\n|\r|\n/).length;
}

/** Names a library file as written in an include or use line: `BOSL2/std.scad` gives `BOSL2`. */
function libraryOf(target: string) {
  const match = /^([A-Za-z0-9_]+)\/[A-Za-z0-9_.-]+\.scad$/.exec(target);
  return match && Object.hasOwn(libraries, match[1]) ? match[1] : undefined;
}

/** Checks one file. Returns the libraries it includes. */
function checkSource(name: string, source: string, files: ProjectFiles): string[] {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new CadError(`${name} is larger than 256 KiB.`, undefined, name);
  }

  // Preserve offsets while hiding strings and comments from the capability checks.
  const code = source.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g,
    (matched) => matched.replace(/[^\r\n]/g, ' '));
  const restricted = [
    [/\b(?:import|import_stl|import_dxf|surface)\s*\(/, 'Imported geometry is unavailable in this version.'],
  ] as const;
  for (const [pattern, message] of restricted) {
    const match = pattern.exec(code);
    if (match) throw new CadError(message, lineOf(code, match.index), name);
  }

  // Comments are blanked above, so read the file name from the original text at the same offset.
  const used = new Set<string>();
  for (const match of code.matchAll(/\b(?:include|use)\s*<([^>\r\n]*)>/g)) {
    const target = source.slice(match.index, match.index + match[0].length).replace(/^[^<]*</, '').slice(0, -1).trim();
    const library = libraryOf(target);
    if (library) {
      used.add(library);
    } else if (!Object.hasOwn(files, target)) {
      throw new CadError(/[\\/]/.test(target) || !target.endsWith('.scad')
        ? `External libraries are unavailable in this version except BOSL2, as in include <BOSL2/std.scad>. Only files in this project can be included otherwise, and ${target || 'this name'} is not one of them.`
        : `${target} is not in this project. Add the file or correct the name.`, lineOf(code, match.index), name);
    }
  }
  return [...used];
}

/** Checks every file of a project and returns the libraries it includes, so the caller can load them. */
export function checkProject(files: ProjectFiles, entry: string): string[] {
  const names = Object.keys(files);
  if (!Object.hasOwn(files, entry)) throw new CadError(`${entry} is not in this project.`);
  if (names.length > MAX_PROJECT_FILES) throw new CadError(`A project can hold ${MAX_PROJECT_FILES} files.`);
  let total = 0;
  const used = new Set<string>();
  for (const name of names) {
    if (!fileNamePattern.test(name)) throw new CadError(`${name} is not a usable file name. Use letters, digits, _ . and -, ending in .scad.`);
    total += files[name].length;
    for (const library of checkSource(name, files[name], files)) used.add(library);
  }
  if (total > MAX_PROJECT_BYTES) throw new CadError('The project is larger than 1 MiB of source.');
  if (!files[entry].trim()) throw new CadError('Write a model before running the editor.', undefined, entry);
  return [...used].sort();
}

export interface Evaluation {
  csg: string;
  /** ECHO lines written by the user's code. */
  messages: string[];
  /** Records printed by part() and joint(). */
  records: string[];
}

/**
 * Evaluate one project file with the official OpenSCAD engine. Call checkProject
 * first. `mounted` holds the libraries the project includes, by name.
 */
export async function evaluateScad(
  files: ProjectFiles,
  entry: string,
  createOpenScad: OpenScadFactory,
  mounted: Record<string, LibraryFiles> = {},
): Promise<Evaluation> {
  let firstProblem: string | undefined;
  const messages: string[] = [];
  const records: string[] = [];
  const print = (text: string) => {
    if (/^(?:ERROR|WARNING):/.test(text)) firstProblem ??= text;
    if (!text.startsWith('ECHO:')) return;
    const body = text.slice(5).trim();
    if (body.startsWith(recordMarker)) {
      if (records.length < maxRecords) records.push(body);
    } else if (messages.length < 12) {
      messages.push(text.slice(0, 400));
    }
  };

  // The packaged CLI is single use. A fresh instance also isolates each job's files.
  const scad = await createOpenScad({ noInitialRun: true, print, printErr: print });
  for (const [name, source] of Object.entries(files)) {
    // Modules can be defined after use, so the prelude goes last and line numbers stay true.
    scad.FS.writeFile(`/${name}`, name === entry ? `${source}\n${assemblyPrelude}` : source);
  }
  // A library is a folder next to the project files, so include <BOSL2/std.scad> finds it.
  for (const [library, contents] of Object.entries(mounted)) {
    scad.FS.mkdir(`/${library}`);
    for (const [name, bytes] of Object.entries(contents)) scad.FS.writeFile(`/${library}/${name}`, bytes);
  }
  let status: number | undefined;
  let commandFailed = false;
  try {
    status = scad.callMain(['--hardwarnings', '-o', csgPath, `/${entry}`]);
  } catch {
    commandFailed = true;
  }

  if (firstProblem) {
    const place = /\bin file (.+?), line (\d+)/.exec(firstProblem);
    const reported = place?.[1].split('/').at(-1);
    const file = reported && Object.hasOwn(files, reported) ? reported : entry;
    const message = firstProblem.replace(/^(?:ERROR|WARNING):\s*/, '')
      .replace(/ in file .+?(?:, line \d+|$)/, '').slice(0, 800);
    // A file name that passed checkProject but is not in the library.
    const missing = /^Can't open (?:include file|library) '([^']+)'/.exec(message)?.[1];
    if (missing && libraryOf(missing)) {
      throw new CadError(`${missing} is not a file in ${missing.split('/')[0]}. Check the spelling against the library's file names, for example BOSL2/std.scad, BOSL2/gears.scad or BOSL2/threading.scad.`,
        place ? Number(place[2]) : undefined, file);
    }
    throw new CadError(message, place ? Number(place[2]) : undefined, file);
  }
  if (commandFailed || status !== 0) throw new CadError('OpenSCAD could not evaluate this source.', undefined, entry);

  let csg: string;
  try {
    csg = scad.FS.readFile(csgPath, { encoding: 'utf8' });
  } catch {
    throw new CadError('OpenSCAD produced no geometry.', undefined, entry);
  }
  return { csg, messages, records };
}

/**
 * Mesh a CSG dump, or a slice of one, with OpenSCAD's own renderer. Returns a
 * binary STL. A dump is valid OpenSCAD input, so no libraries are needed.
 */
export async function renderMesh(csg: string, createOpenScad: OpenScadFactory): Promise<Uint8Array> {
  const lines: string[] = [];
  const print = (text: string) => lines.push(text);
  const scad = await createOpenScad({ noInitialRun: true, print, printErr: print });
  scad.FS.writeFile(meshInput, csg);
  let status: number | undefined;
  try {
    status = scad.callMain(['--backend=manifold', '--export-format=binstl', '-o', meshOutput, meshInput]);
  } catch {
    status = undefined;
  }

  // These two are reported as plain lines, with no ERROR or WARNING prefix.
  if (lines.some((line) => line.includes('Current top level object is not a 3D object'))) {
    throw new CadError('This file draws only flat 2D shapes. Wrap them in linear_extrude(height) to give them thickness.');
  }
  if (lines.some((line) => line.includes('Current top level object is empty'))) {
    throw new CadError('This model has no solid volume. Check the dimensions and Boolean operations.');
  }
  if (status !== 0) throw new CadError('OpenSCAD could not build a mesh for this part.');
  try {
    return scad.FS.readFile(meshOutput);
  } catch {
    throw new CadError('OpenSCAD produced no mesh for this part.');
  }
}

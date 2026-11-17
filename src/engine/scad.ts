import { assemblyPrelude, fileNamePattern, recordMarker } from './assembly.ts';
import { CadError, MAX_PROJECT_BYTES, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type ProjectFiles } from './protocol.ts';

export interface OpenScadModule {
  callMain(args: string[]): number;
  FS: {
    writeFile(path: string, data: string): void;
    readFile(path: string, options: { encoding: 'utf8' }): string;
  };
}

export type OpenScadFactory = (options: {
  noInitialRun: true;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<OpenScadModule>;

const csgPath = '/partscript-output.csg';
const maxRecords = 1_000;

function lineOf(code: string, index: number) {
  return code.slice(0, index).split(/\r\n|\r|\n/).length;
}

function checkSource(name: string, source: string, files: ProjectFiles) {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new CadError(`${name} is larger than 256 KiB.`, undefined, name);
  }

  // Preserve offsets while hiding strings and comments from the capability checks.
  const code = source.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g,
    (matched) => matched.replace(/[^\r\n]/g, ' '));
  const restricted = [
    [/\b(?:import|import_stl|import_dxf|surface)\s*\(/, 'Imported geometry is unavailable in this version.'],
    [/\$(?:fn|fa|fs)\s*=(?!=)/, 'Remove the facet override. This version builds smooth curves for STEP.'],
  ] as const;
  for (const [pattern, message] of restricted) {
    const match = pattern.exec(code);
    if (match) throw new CadError(message, lineOf(code, match.index), name);
  }

  // Comments are blanked above, so read the file name from the original text at the same offset.
  for (const match of code.matchAll(/\b(?:include|use)\s*<([^>\r\n]*)>/g)) {
    const target = source.slice(match.index, match.index + match[0].length).replace(/^[^<]*</, '').slice(0, -1).trim();
    if (!Object.hasOwn(files, target)) {
      throw new CadError(/[\\/]/.test(target) || !target.endsWith('.scad')
        ? `External libraries are unavailable in this version. Only files in this project can be included, and ${target || 'this name'} is not one of them.`
        : `${target} is not in this project. Add the file or correct the name.`, lineOf(code, match.index), name);
    }
  }
}

export function checkProject(files: ProjectFiles, entry: string) {
  const names = Object.keys(files);
  if (!Object.hasOwn(files, entry)) throw new CadError(`${entry} is not in this project.`);
  if (names.length > MAX_PROJECT_FILES) throw new CadError(`A project can hold ${MAX_PROJECT_FILES} files.`);
  let total = 0;
  for (const name of names) {
    if (!fileNamePattern.test(name)) throw new CadError(`${name} is not a usable file name. Use letters, digits, _ . and -, ending in .scad.`);
    total += files[name].length;
    checkSource(name, files[name], files);
  }
  if (total > MAX_PROJECT_BYTES) throw new CadError('The project is larger than 1 MiB of source.');
  if (!files[entry].trim()) throw new CadError('Write a model before running the editor.', undefined, entry);
}

export interface Evaluation {
  csg: string;
  /** ECHO lines written by the user's code. */
  messages: string[];
  /** Records printed by part() and joint(). */
  records: string[];
}

/** Evaluate one project file with the official OpenSCAD engine. Call checkProject first. */
export async function evaluateScad(files: ProjectFiles, entry: string, createOpenScad: OpenScadFactory): Promise<Evaluation> {
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

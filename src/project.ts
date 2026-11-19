import { strFromU8, strToU8, unzip, unzipSync, zip, zipSync, type UnzipFileFilter, type Zippable } from 'fflate';
import { readDrawingOptions } from './drawing/options.ts';
import type { DrawingOptions } from './drawing/types.ts';
import { fileNamePattern } from './engine/assembly.ts';
import { assetNamePattern, formatBytes, unreadableFormat } from './engine/assets.ts';
import { CadError, MAX_ASSET_BYTES, MAX_ASSETS_BYTES, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type ProjectAssets, type ProjectFiles } from './engine/protocol.ts';

export interface TextFile {
  name: string;
  source: string;
}

/** An imported STEP or STL. Its bytes are kept exactly as they were opened. */
export interface AssetFile {
  name: string;
  data: Uint8Array;
}

export type ProjectFile = TextFile | AssetFile;

export interface Project {
  files: ProjectFile[];
  /** The file shown in the editor. */
  active: string;
  /** The file Run builds. Null builds the file shown in the editor. */
  entry: string | null;
  /** The sheet size, projection and title block fields of the Drawing dialog. Absent until they are changed. */
  drawing?: DrawingOptions;
}

export function isAsset(file: ProjectFile): file is AssetFile {
  return 'data' in file;
}

/** The text files, by name, for the engine. */
export function toFiles(project: Pick<Project, 'files'>): ProjectFiles {
  const files: ProjectFiles = {};
  for (const file of project.files) if (!isAsset(file)) files[file.name] = file.source;
  return files;
}

/** The imported files, by name, for the engine. */
export function toAssets(project: Pick<Project, 'files'>): ProjectAssets {
  const assets: ProjectAssets = {};
  for (const file of project.files) if (isAsset(file)) assets[file.name] = file.data;
  return assets;
}

/** Make a name the engine accepts: letters, digits, _ . and -, ending in .scad. */
export function scadFilename(name: string) {
  const stem = name.trim().replace(/\.scad$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[.-]+/, '').slice(0, 70);
  const result = `${stem || 'part'}.scad`;
  return fileNamePattern.test(result) ? result : 'part.scad';
}

/** True for a name that is read as an imported file whatever the case of its extension. */
export function isAssetName(name: string) {
  return /\.(?:step|stp|stl)$/i.test(name);
}

/** The name an imported file is stored under: the extension in lower case, the rest made safe. */
export function assetFilename(name: string) {
  const extension = /\.(step|stp|stl)$/i.exec(name)?.[1].toLowerCase() ?? 'step';
  const stem = name.trim().replace(/\.(?:step|stp|stl)$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[.-]+/, '').slice(0, 70);
  const result = `${stem || 'part'}.${extension}`;
  return assetNamePattern.test(result) ? result : `part.${extension}`;
}

export function uniqueName(wanted: string, taken: string[]) {
  if (!taken.includes(wanted)) return wanted;
  const dot = wanted.lastIndexOf('.');
  const [stem, extension] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ''];
  for (let n = 2; ; n++) if (!taken.includes(`${stem}_${n}${extension}`)) return `${stem}_${n}${extension}`;
}

/**
 * Add files to a project without changing any file that is already in it, whatever the project holds.
 * A file whose name is taken keeps both: it gets the next free `_2`, `_3` and so on (`arm.scad` becomes
 * `arm_2.scad`), and so do two incoming files that share a name. `renamed` says which names changed.
 */
export function addFiles(existing: ProjectFile[], incoming: ProjectFile[]) {
  const taken = existing.map((file) => file.name);
  const added: ProjectFile[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const file of incoming) {
    const name = uniqueName(file.name, taken);
    taken.push(name);
    if (name !== file.name) renamed.push({ from: file.name, to: name });
    added.push({ ...file, name });
  }
  return { files: [...existing, ...added], added, renamed };
}

/**
 * What is wrong with a set of files, in a sentence for the engineer, or undefined when they fit:
 * 40 files, 256 KiB of text each, 40 MB for each imported file and 120 MB for all of them.
 */
export function projectProblem(files: ProjectFile[]): string | undefined {
  if (files.length > MAX_PROJECT_FILES) return `A project can hold ${MAX_PROJECT_FILES} files.`;
  let assetBytes = 0;
  for (const file of files) {
    if (isAsset(file)) {
      if (file.data.byteLength > MAX_ASSET_BYTES) {
        return `${file.name} is ${formatBytes(file.data.byteLength)}. One imported file can be up to ${formatBytes(MAX_ASSET_BYTES)}. Export a simpler version, or leave out small parts such as screws and threads.`;
      }
      assetBytes += file.data.byteLength;
    } else if (file.source.length > MAX_SOURCE_BYTES) {
      return `${file.name} is larger than 256 KiB.`;
    }
  }
  if (assetBytes > MAX_ASSETS_BYTES) {
    return `The imported files add up to ${formatBytes(assetBytes)}. A project can hold ${formatBytes(MAX_ASSETS_BYTES)} of them. Remove a file that is not needed.`;
  }
  return undefined;
}

const projectFormat = 'partscript-project';
const manifestName = 'partscript.json';

/** The project as a version 1 file: text only. Kept for tests and for anything that still reads it. */
export function serializeProject(project: Project) {
  return JSON.stringify({ format: projectFormat, version: 1, entry: project.entry, active: project.active, drawing: project.drawing, files: toFiles(project) }, null, 2);
}

function zipEntries(project: Project): Zippable {
  const entries: Zippable = {
    [manifestName]: [strToU8(JSON.stringify({ format: projectFormat, version: 2, entry: project.entry, active: project.active, drawing: project.drawing }, null, 2)), { level: 6 }],
  };
  for (const file of project.files) {
    // A STEP is text and shrinks a lot. An STL is mostly numbers, so spend less time on it.
    entries[file.name] = isAsset(file) ? [file.data, { level: file.name.endsWith('.stl') ? 1 : 6 }] : [strToU8(file.source), { level: 6 }];
  }
  return entries;
}

/**
 * The project as a zip: every file at the top level under its own name, and partscript.json holding which
 * file Run builds and which is open. Imported files are stored as they are.
 */
export function serializeProjectZip(project: Project): Uint8Array {
  return zipSync(zipEntries(project));
}

/** The same zip, made off the page's thread, so a project with large imported files does not freeze it. */
export function serializeProjectZipAsync(project: Project): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(zipEntries(project), (error, data) => (error ? reject(new CadError('The project could not be zipped.')) : resolve(data)));
  });
}

/** Skips what a zip program adds, and refuses a file that would be too large before it is unpacked. */
function zipFilter(): UnzipFileFilter {
  let total = 0;
  return (info) => {
    if (info.name.endsWith('/') || /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/.test(info.name)) return false;
    const limit = isAssetName(info.name) ? MAX_ASSET_BYTES : MAX_SOURCE_BYTES * 4;
    if (info.originalSize > limit && !info.name.endsWith(manifestName)) {
      throw new CadError(`${info.name} in the zip is ${formatBytes(info.originalSize)}, which is more than a project file can be (${formatBytes(limit)}).`);
    }
    total += info.originalSize;
    if (total > MAX_ASSETS_BYTES + MAX_PROJECT_FILES * MAX_SOURCE_BYTES) throw new CadError('The zip holds more than a project can.');
    return true;
  };
}

const damaged = 'This is not a zip file that can be opened. It may be damaged, or it may not have finished downloading.';

/** Open a zip a project was saved as. Throws a CadError that says what is wrong with the zip. */
export function readProjectZip(bytes: Uint8Array): Project {
  try {
    return projectFromEntries(unzipSync(bytes, { filter: zipFilter() }));
  } catch (error) {
    throw error instanceof CadError ? error : new CadError(damaged);
  }
}

/** The same, unpacked off the page's thread. */
export function readProjectZipAsync(bytes: Uint8Array): Promise<Project> {
  return new Promise((resolve, reject) => {
    try {
      unzip(bytes, { filter: zipFilter() }, (error, unpacked) => {
        if (error) return reject(error instanceof CadError ? error : new CadError(damaged));
        try {
          resolve(projectFromEntries(unpacked));
        } catch (problem) {
          reject(problem);
        }
      });
    } catch (error) {
      reject(error instanceof CadError ? error : new CadError(damaged));
    }
  });
}

function projectFromEntries(unpacked: Record<string, Uint8Array>): Project {
  // A zip made from a folder keeps the folder's name in front of every file. Drop it when all files share one.
  const names = Object.keys(unpacked);
  const folder = names.length && names.every((name) => name.includes('/')) ? names[0].split('/')[0] : undefined;
  const strip = (name: string) => (folder !== undefined && name.startsWith(`${folder}/`) ? name.slice(folder.length + 1) : name);

  const entries = new Map(Object.entries(unpacked).map(([name, data]) => [strip(name), data]));
  let manifest: Record<string, unknown> = {};
  const raw = entries.get(manifestName);
  if (raw) {
    try {
      manifest = JSON.parse(strFromU8(raw)) as Record<string, unknown>;
    } catch {
      throw new CadError(`${manifestName} in the zip is not readable. Delete it from the zip to open the files without it.`);
    }
    if (manifest.format !== projectFormat) throw new CadError(`${manifestName} in the zip is not from Partscript.`);
    if (typeof manifest.version === 'number' && manifest.version > 2) {
      throw new CadError('This project was saved by a newer version of Partscript. Open the site again later to read it.');
    }
  }

  const files: ProjectFile[] = [];
  for (const [name, data] of entries) {
    if (name === manifestName) continue;
    if (fileNamePattern.test(name)) {
      files.push({ name, source: strFromU8(data) });
    } else if (assetNamePattern.test(name)) {
      files.push({ name, data });
    } else {
      const unreadable = unreadableFormat(name);
      if (unreadable) throw new CadError(unreadable);
      // Anything else in the zip, such as a readme, is left out.
    }
  }
  if (!files.length) throw new CadError('The zip holds no .scad, .step, .stp or .stl files.');
  const problem = projectProblem(files);
  if (problem) throw new CadError(problem);
  const has = (name: unknown): name is string => typeof name === 'string' && files.some((file) => file.name === name);
  const entry = has(manifest.entry) ? manifest.entry : null;
  return withDrawing({ files, active: has(manifest.active) ? manifest.active : entry ?? files[0].name, entry }, manifest.drawing);
}

/** The project with its drawing settings, when it has any. A project without them has no such key at all. */
function withDrawing(project: Project, saved: unknown): Project {
  const drawing = readDrawingOptions(saved);
  return drawing ? { ...project, drawing } : project;
}

/** Read a saved project (version 1 JSON) or a stored draft. Returns undefined for anything else. */
export function readProject(value: unknown): Project | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  // Drafts saved before projects existed held one file.
  if (typeof data.source === 'string' && typeof data.filename === 'string') {
    const name = scadFilename(data.filename);
    return { files: [{ name, source: data.source }], active: name, entry: null };
  }
  const list: [unknown, unknown][] = Array.isArray(data.files)
    ? data.files.map((file: unknown) => {
      const item = (file ?? {}) as Record<string, unknown>;
      return [item.name, 'data' in item ? item.data : item.source];
    })
    : data.files && typeof data.files === 'object' ? Object.entries(data.files) : [];
  const files: ProjectFile[] = [];
  for (const [name, content] of list) {
    if (typeof name !== 'string' || files.some((file) => file.name === name)) return undefined;
    if (typeof content === 'string' && fileNamePattern.test(name)) {
      if (content.length > MAX_SOURCE_BYTES) return undefined;
      files.push({ name, source: content });
    } else if (content instanceof Uint8Array && assetNamePattern.test(name)) {
      files.push({ name, data: content });
    } else {
      return undefined;
    }
  }
  if (!files.length || projectProblem(files)) return undefined;
  const has = (name: unknown): name is string => typeof name === 'string' && files.some((file) => file.name === name);
  const entry = has(data.entry) ? data.entry : null;
  return withDrawing({ files, active: has(data.active) ? data.active : entry ?? files[0].name, entry }, data.drawing);
}

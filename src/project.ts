import { fileNamePattern } from './engine/assembly.ts';
import { MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type ProjectFiles } from './engine/protocol.ts';

export interface ProjectFile {
  name: string;
  source: string;
}

export interface Project {
  files: ProjectFile[];
  /** The file shown in the editor. */
  active: string;
  /** The file Run builds. Null builds the file shown in the editor. */
  entry: string | null;
}

export function toFiles(project: Project): ProjectFiles {
  return Object.fromEntries(project.files.map((file) => [file.name, file.source]));
}

/** Make a name the engine accepts: letters, digits, _ . and -, ending in .scad. */
export function scadFilename(name: string) {
  const stem = name.trim().replace(/\.scad$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[.-]+/, '').slice(0, 70);
  const result = `${stem || 'part'}.scad`;
  return fileNamePattern.test(result) ? result : 'part.scad';
}

export function uniqueName(wanted: string, taken: string[]) {
  if (!taken.includes(wanted)) return wanted;
  const stem = wanted.replace(/\.scad$/i, '');
  for (let n = 2; ; n++) if (!taken.includes(`${stem}_${n}.scad`)) return `${stem}_${n}.scad`;
}

const projectFormat = 'partscript-project';

export function serializeProject(project: Project) {
  return JSON.stringify({ format: projectFormat, version: 1, entry: project.entry, active: project.active, files: toFiles(project) }, null, 2);
}

/** Read a saved project or a stored draft. Returns undefined for anything else. */
export function readProject(value: unknown): Project | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  // Drafts saved before projects existed held one file.
  if (typeof data.source === 'string' && typeof data.filename === 'string') {
    const name = scadFilename(data.filename);
    return { files: [{ name, source: data.source }], active: name, entry: null };
  }
  const list = Array.isArray(data.files)
    ? data.files.map((file: unknown) => [(file as ProjectFile)?.name, (file as ProjectFile)?.source])
    : data.files && typeof data.files === 'object' ? Object.entries(data.files) : [];
  const files: ProjectFile[] = [];
  for (const [name, source] of list) {
    if (typeof name !== 'string' || typeof source !== 'string' || !fileNamePattern.test(name)) return undefined;
    if (source.length > MAX_SOURCE_BYTES || files.some((file) => file.name === name)) return undefined;
    files.push({ name, source });
  }
  if (!files.length || files.length > MAX_PROJECT_FILES) return undefined;
  const has = (name: unknown): name is string => typeof name === 'string' && files.some((file) => file.name === name);
  const entry = has(data.entry) ? data.entry : null;
  return { files, active: has(data.active) ? data.active : entry ?? files[0].name, entry };
}

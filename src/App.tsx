import { BookOpen, Box, Boxes, Braces, Check, ChevronDown, ChevronRight, CircleHelp, CodeXml, Download, Ellipsis, FileBox, FileCode2, FilePlus, FolderArchive, FolderOpen, HardDrive, LoaderCircle, Pencil, Pin, Play, Plus, Square, Terminal, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CodeEditor, type EditorControl } from './components/CodeEditor.tsx';
import { AssetPanel } from './components/AssetPanel.tsx';
import { Viewport } from './components/Viewport.tsx';
import { clampJoint, defaultPose, fileNamePattern, structureOf, type AssemblySpec } from './engine/assembly.ts';
import { stemOf, unreadableFormat, formatBytes } from './engine/assets.ts';
import { BrowserGeometryEngine } from './engine/client.ts';
import { loopStates, openingPose, settlePose } from './engine/kinematics.ts';
import { facetedText, flatRoundNotes } from './engine/summary.ts';
import { CadError, MAX_ASSET_BYTES, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type BuildStage, type Diagnostic, type MeasurePick, type ModelPreview, type Pose } from './engine/protocol.ts';
import { loadDraft, saveDraft } from './drafts.ts';
import { exampleProjects } from './examples.ts';
import { assetFilename, isAsset, isAssetName, projectProblem, readProject, readProjectZipAsync, scadFilename, serializeProjectZipAsync, toAssets, toFiles, uniqueName, type Project, type ProjectFile } from './project.ts';

interface DocumentState extends Project {
  revision: number;
  fileKey: number;
}

interface Notice {
  kind: 'idle' | 'success' | 'error';
  text: string;
  diagnostic?: Diagnostic;
}

const starter = exampleProjects[0];
const stages: Record<BuildStage, string> = {
  load: 'Loading CAD engines…',
  evaluate: 'Evaluating OpenSCAD…',
  model: 'Building the solids…',
  mesh: 'Preparing the preview…',
  export: 'Writing STEP…',
};

function download(data: string | Uint8Array<ArrayBuffer>, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function elapsed(milliseconds: number) {
  return milliseconds < 1000 ? `${Math.max(1, Math.round(milliseconds))} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function builtText(model: ModelPreview) {
  const { parts, joints } = model.assembly;
  const faceted = facetedText(model);
  const flat = faceted ? ` ${faceted}` : '';
  if (!model.isAssembly) return `Built one solid in ${elapsed(model.buildMs)}.${flat}`;
  const kept = parts.length > 1 && model.rebuilt < model.meshes.length ? ` ${count(model.rebuilt, 'solid')} rebuilt, the rest reused.` : '';
  const loops = structureOf(model.assembly).closures.length;
  return `Built ${count(parts.length, 'part')} and ${count(joints.length, 'joint')}${loops ? ` with ${count(loops, 'closed loop')}` : ''} in ${elapsed(model.buildMs)}.${kept}${flat}`;
}

/**
 * The pose to show after a build. Joints the user moved stay where they are,
 * unless the code changed that joint. Loops are then shut again, because an
 * edited link length moves the joints around its loop.
 */
function carryPose(next: AssemblySpec, previous: AssemblySpec | undefined, pose: Pose) {
  if (!previous) return openingPose(next);
  const result = defaultPose(next);
  for (const joint of next.joints) {
    const before = previous.joints.find((item) => item.name === joint.name);
    const unchanged = before && before.type === joint.type && before.value === joint.value
      && before.limits[0] === joint.limits[0] && before.limits[1] === joint.limits[1];
    if (unchanged && joint.name in pose && joint.name in result) result[joint.name] = clampJoint(joint, pose[joint.name]);
  }
  const { looped } = structureOf(next);
  const settled = settlePose(next, result, next.joints.filter((joint, j) => looped[j] && joint.given).map((joint) => joint.name));
  return settled.closed ? settled : openingPose(next);
}

function openLoopText(assembly: AssemblySpec, pose: Pose) {
  const open = loopStates(assembly, pose).filter((loop) => !loop.closed);
  if (!open.length) return undefined;
  const [first] = open;
  return `The loop at joint "${first.joint}" cannot close: its two halves stay ${(Math.round(first.gap * 100) / 100)} mm apart. Check the link lengths and the at and child_at positions${open.length > 1 ? `, here and at ${count(open.length - 1, 'more joint')}` : ''}.`;
}

/** What a new .scad file holds: a small solid, so Run has something to build. */
function blankSource(name: string) {
  return `// ${name.replace(/\.scad$/i, '')} · dimensions in mm\ncube([20, 20, 10]);\n`;
}

function sameFiles(a: ProjectFile[], b: ProjectFile[]) {
  // An imported file is the same file while it is the same array of bytes.
  return a.length === b.length && a.every((file, i) => file.name === b[i].name && (isAsset(file) || isAsset(b[i])
    ? isAsset(file) && isAsset(b[i]) && file.data === b[i].data
    : file.source === (b[i] as { source: string }).source));
}

export function App() {
  const [engine] = useState(() => new BrowserGeometryEngine());
  const [doc, setDoc] = useState<DocumentState>(() => ({
    files: Object.entries(starter.files).map(([name, source]) => ({ name, source })),
    active: starter.open, entry: starter.open, revision: 0, fileKey: 0,
  }));
  const latest = useRef(doc);
  const savedFiles = useRef(doc.files);
  const busy = useRef(false);
  const editor = useRef<EditorControl>(null);
  const pendingLine = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const examplesMenu = useRef<HTMLDetailsElement>(null);
  const help = useRef<HTMLDialogElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1, count: 1 });
  const [stage, setStage] = useState<BuildStage | null>(null);
  const [preview, setPreview] = useState<ModelPreview>();
  /** Log lines about the last build that are not errors, such as a hexagon made with $fn. */
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [pose, setPose] = useState<Pose>({});
  const shownPose = useRef(pose);
  const shownAssembly = useRef<AssemblySpec | undefined>(undefined);
  const [builtRevision, setBuiltRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice>({ kind: 'idle', text: 'Opening the workspace…' });
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [storage, setStorage] = useState<'saving' | 'saved' | 'unavailable'>('saving');
  const [outputOpen, setOutputOpen] = useState(true);
  // On a narrow screen one pane shows at a time. The preview comes first, and the code is behind a toggle.
  const [view, setView] = useState<'preview' | 'code'>('preview');
  // On a narrow screen the file actions sit in a menu.
  const [moreOpen, setMoreOpen] = useState(false);
  // iOS greys out a file whose type it cannot match to the accept list, and it does not know .step or .stp, so a download from
  // GrabCAD could not be chosen. On a touch screen the picker shows every file. openFiles still refuses anything that is not CAD.
  const [anyFile] = useState(() => window.matchMedia('(pointer: coarse)').matches);
  const currentBuild = builtRevision === doc.revision;
  const canExport = currentBuild && stage === null;
  const activeFile = doc.files.find((file) => file.name === doc.active) ?? doc.files[0];
  const target = doc.entry ?? doc.active;

  function updateDocument(next: DocumentState) {
    latest.current = next;
    setDoc(next);
  }

  function updatePose(next: Pose) {
    shownPose.current = next;
    setPose(next);
  }

  async function run(snapshot = latest.current, extra: Record<string, string> = {}) {
    if (busy.current) return;
    busy.current = true;
    setBuiltRevision(null);
    setStage('load');
    const entry = snapshot.entry ?? snapshot.active;
    try {
      const files = { ...toFiles(snapshot), ...extra };
      const result = await engine.build(files, toAssets(snapshot), entry, snapshot.revision, setStage);
      const rounds = flatRoundNotes(result, files, entry);
      const opening = carryPose(result.assembly, shownAssembly.current, shownPose.current);
      const openLoop = opening.closed ? undefined : openLoopText(result.assembly, opening.pose);
      updatePose(opening.pose);
      shownAssembly.current = result.assembly;
      setPreview(result);
      setBuildLog(rounds.logs);
      setBuiltRevision(snapshot.revision);
      // Run keeps building an assembly while its part files are being edited.
      if (result.isAssembly && latest.current.entry === null && latest.current.files.some((file) => file.name === entry)) {
        updateDocument({ ...latest.current, entry });
      }
      // The part is built and can be exported, but something in it is probably not what was meant.
      const problems = [...(openLoop ? [openLoop] : []), ...rounds.errors];
      if (problems.length) setOutputOpen(true);
      setNotice(snapshot.revision === latest.current.revision
        ? (problems.length ? { kind: 'error', text: `${builtText(result)} ${problems.join(' ')}` } : { kind: 'success', text: builtText(result) })
        : { kind: 'idle', text: 'Code changed during the build. Run again to update the preview.' });
    } catch (error) {
      const diagnostic: Diagnostic = error instanceof CadError
        ? { message: error.message, line: error.line, file: error.file }
        : { message: 'The geometry build failed. Try running the code again.' };
      if (snapshot.revision === latest.current.revision) {
        setNotice({ kind: diagnostic.message.startsWith('Cancelled.') ? 'idle' : 'error', text: diagnostic.message, diagnostic });
        setOutputOpen(true);
      }
    } finally {
      busy.current = false;
      setStage(null);
    }
  }

  /** Read picks of the model on screen. The worker keeps the last build, so a stale preview can still be measured. */
  async function measurePicks(picks: MeasurePick[], at: Pose) {
    if (builtRevision === null) throw new CadError('Run the code, then measure the model it builds.');
    if (busy.current) throw new CadError('The engine is busy with a build or an export. Pick again when it has finished.');
    busy.current = true;
    try {
      return await engine.measure(builtRevision, at, picks);
    } finally {
      busy.current = false;
    }
  }

  async function exportStep() {
    const snapshot = latest.current;
    if (busy.current || snapshot.revision !== builtRevision) return;
    busy.current = true;
    setStage('export');
    try {
      const bytes = await engine.exportStep(snapshot.revision, shownPose.current, setStage);
      if (latest.current.revision !== snapshot.revision) {
        setNotice({ kind: 'idle', text: 'Code changed during export. Run the current code to export it.' });
        return;
      }
      const name = (snapshot.entry ?? snapshot.active).replace(/\.scad$/i, '.step');
      download(bytes, name, 'model/step');
      setNotice({ kind: 'success', text: preview?.isAssembly ? `Exported ${name} with the parts in the pose shown.` : `Exported ${name}.` });
    } catch (error) {
      setBuiltRevision(null);
      const message = error instanceof Error ? error.message : 'STEP export failed.';
      setNotice({ kind: message.startsWith('Cancelled.') ? 'idle' : 'error', text: message });
      setOutputOpen(true);
    } finally {
      busy.current = false;
      setStage(null);
    }
  }

  function saveScad() {
    const current = latest.current;
    const file = current.files.find((item) => item.name === current.active);
    if (!file) return;
    if (isAsset(file)) download(file.data as Uint8Array<ArrayBuffer>, file.name, 'application/octet-stream');
    else download(file.source, file.name, 'text/plain;charset=utf-8');
    if (current.files.length === 1) savedFiles.current = current.files;
    if (!busy.current) setNotice({ kind: 'success', text: `Saved ${file.name}.` });
  }

  async function saveProject() {
    const current = latest.current;
    const name = `${stemOf(current.entry ?? current.active)}.partscript.zip`;
    try {
      const bytes = await serializeProjectZipAsync(current);
      download(bytes as Uint8Array<ArrayBuffer>, name, 'application/zip');
      savedFiles.current = current.files;
      if (!busy.current) setNotice({ kind: 'success', text: `Saved ${name} with ${count(current.files.length, 'file')}.` });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof CadError ? error.message : 'The project could not be saved.' });
      setOutputOpen(true);
    }
  }

  /** Start again with one blank file. Add files with the + beside the tabs. */
  function newProject() {
    replaceDocument({ files: [{ name: 'part.scad', source: blankSource('part.scad') }], active: 'part.scad', entry: null });
  }

  function unsaved() {
    return !sameFiles(savedFiles.current, latest.current.files);
  }

  function replaceDocument(project: Project) {
    if (busy.current) return;
    if (unsaved() && !window.confirm('Replace the current project? Save the project first to keep a copy.')) return;
    const next = { ...project, revision: latest.current.revision + 1, fileKey: latest.current.fileKey + 1 };
    savedFiles.current = project.files;
    updateDocument(next);
    setPreview(undefined);
    shownAssembly.current = undefined;
    updatePose({});
    setBuiltRevision(null);
    setOutputOpen(true);
    void run(next);
  }

  /** Change the file list. Any change makes the last build stale. */
  function editProject(change: Partial<Project>, text?: string) {
    const before = latest.current;
    updateDocument({ ...before, ...change, revision: before.revision + 1, fileKey: before.fileKey + 1 });
    setNotice({ kind: 'idle', text: text ?? 'Project changed. Run to update the preview.' });
  }

  function showFile(name: string, line?: number) {
    const before = latest.current;
    if (!before.files.some((file) => file.name === name)) return;
    if (name === before.active) {
      if (line) editor.current?.goToLine(line);
      return;
    }
    pendingLine.current = line ?? null;
    updateDocument({ ...before, active: name });
  }

  function askName(message: string, suggestion: string, except?: string) {
    const typed = window.prompt(message, suggestion);
    if (typed === null || !typed.trim()) return undefined;
    // An imported file keeps its kind: a name typed without an extension keeps the old one.
    const wasAsset = isAssetName(suggestion);
    const name = wasAsset
      ? assetFilename(isAssetName(typed) ? typed : `${typed.trim()}${/\.[A-Za-z]+$/.exec(suggestion)?.[0] ?? '.step'}`)
      : scadFilename(typed);
    if (!(wasAsset ? /\.(?:step|stp|stl)$/ : fileNamePattern).test(name)) {
      setNotice({ kind: 'error', text: 'Use letters, digits, _ . and - in a file name.' });
      return undefined;
    }
    if (name !== except && latest.current.files.some((file) => file.name === name)) {
      setNotice({ kind: 'error', text: `${name} is already in this project.` });
      return undefined;
    }
    return name;
  }

  function addFile() {
    const before = latest.current;
    if (busy.current) return;
    if (before.files.length >= MAX_PROJECT_FILES) {
      setNotice({ kind: 'error', text: `A project can hold ${MAX_PROJECT_FILES} files.` });
      return;
    }
    const name = askName('Name the new file', uniqueName('part.scad', before.files.map((file) => file.name)));
    if (!name) return;
    editProject({ files: [...before.files, { name, source: blankSource(name) }], active: name }, `Added ${name}.`);
  }

  function renameFile(old: string) {
    const before = latest.current;
    if (busy.current) return;
    const name = askName(`Rename ${old}`, old, old);
    if (!name || name === old) return;
    const used = before.files.some((file) => file.name !== old && !isAsset(file) && file.source.includes(old));
    editProject({
      files: before.files.map((file) => (file.name === old ? { ...file, name } : file)),
      active: before.active === old ? name : before.active,
      entry: before.entry === old ? name : before.entry,
    }, used ? `Renamed to ${name}. Other files still mention ${old}. Update them before you run.` : `Renamed to ${name}.`);
  }

  function deleteFile(name: string) {
    const before = latest.current;
    if (busy.current || before.files.length < 2) return;
    if (!window.confirm(`Delete ${name} from this project?`)) return;
    const files = before.files.filter((file) => file.name !== name);
    const index = Math.max(0, before.files.findIndex((file) => file.name === name) - 1);
    editProject({
      files,
      active: before.active === name ? files[index].name : before.active,
      entry: before.entry === name ? null : before.entry,
    }, `Deleted ${name}.`);
  }

  function pinFile(name: string) {
    const before = latest.current;
    const entry = before.entry === name ? null : name;
    updateDocument({ ...before, entry, revision: before.revision + 1 });
    setNotice({ kind: 'idle', text: entry ? `Run now builds ${entry}, whichever file is open.` : 'Run now builds the file that is open.' });
  }

  async function openFiles(list: File[]) {
    try {
      if (busy.current) return;
      const added: ProjectFile[] = [];
      for (const file of list) {
        const unreadable = unreadableFormat(file.name);
        if (unreadable) throw new CadError(unreadable);
        if (/\.zip$/i.test(file.name)) {
          replaceDocument(await readProjectZipAsync(new Uint8Array(await file.arrayBuffer())));
          return;
        }
        if (isAssetName(file.name)) {
          if (file.size > MAX_ASSET_BYTES) {
            throw new CadError(`${file.name} is ${formatBytes(file.size)}. One imported file can be up to ${formatBytes(MAX_ASSET_BYTES)}. Export a simpler version, or leave out small parts such as screws and threads.`);
          }
          added.push({ name: assetFilename(file.name), data: new Uint8Array(await file.arrayBuffer()) });
          continue;
        }
        if (!/\.(?:scad|json)$/i.test(file.name)) {
          throw new CadError(`${file.name} is not a file this page opens. Open a .scad file, a .step, .stp or .stl file to import, or a saved project (.zip). If it is OpenSCAD code, rename it to end in .scad.`);
        }
        if (file.size > MAX_SOURCE_BYTES * 8) throw new CadError(`${file.name} is too large to open.`);
        const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (source.includes('\0')) throw new CadError(`${file.name} is not plain text. Open .scad files, .step, .stp or .stl files, or a project zip.`);
        if (/\.json$/i.test(file.name)) {
          let project: Project | undefined;
          try {
            project = readProject(JSON.parse(source));
          } catch {
            project = undefined;
          }
          if (!project) throw new CadError(`${file.name} is not a Partscript project file.`);
          replaceDocument(project);
          return;
        }
        if (file.size > MAX_SOURCE_BYTES) throw new CadError(`${file.name} is larger than 256 KiB.`);
        added.push({ name: scadFilename(file.name), source });
      }
      if (!added.length) return;
      const before = latest.current;
      // One .scad file opens on its own, as before. Anything else joins the current project.
      if (added.length === 1 && !isAsset(added[0]) && before.files.length === 1) {
        replaceDocument({ files: added, active: added[0].name, entry: null });
        return;
      }
      const taken = added.map((file) => file.name);
      added.forEach((file, i) => {
        // Two files that end up with one name keep both.
        if (taken.indexOf(file.name) !== i) file.name = uniqueName(file.name, [...taken, ...before.files.map((item) => item.name)]);
      });
      const replaced = added.filter((file) => before.files.some((item) => item.name === file.name));
      if (replaced.length && !window.confirm(`Replace ${replaced.map((file) => file.name).join(', ')} in this project?`)) return;
      const files = [...before.files.filter((file) => !added.some((item) => item.name === file.name)), ...added];
      const problem = projectProblem(files);
      if (problem) throw new CadError(problem);
      const imported = added.filter(isAsset);
      editProject({ files, active: added[0].name }, imported.length
        ? `Added ${imported.map((file) => `${file.name} (${formatBytes(file.data.byteLength)})`).join(', ')}. Press Show on its own to look at it, or use it as a part.`
        : `Added ${count(added.length, 'file')} to the project.`);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof CadError ? error.message : 'Could not open this file as UTF-8 text.' });
      setOutputOpen(true);
    }
  }

  /** Build an imported file by itself, whichever file Run is set to build. */
  function showOnItsOwn(name: string) {
    if (busy.current) return;
    void run({ ...latest.current, entry: name });
  }

  /** One component of an imported STEP, built alone from a part line that is not in any file. */
  function showComponent(file: string, path: string) {
    if (busy.current) return;
    const name = '_component.scad';
    void run({ ...latest.current, entry: name }, { [name]: `part("component", "${file}", component = "${path.replace(/"/g, '')}");` });
  }

  function editSource(source: string) {
    const before = latest.current;
    const file = before.files.find((item) => item.name === before.active);
    if (!file || isAsset(file) || source === file.source) return;
    updateDocument({
      ...before, revision: before.revision + 1,
      files: before.files.map((item) => (item === file ? { ...item, source } : item)),
    });
    setNotice({ kind: 'idle', text: 'Code changed. Run to update the preview.' });
  }

  // Keep the open file's tab in view: the strip scrolls sideways on a phone, and a file that was just added lands at its end.
  // The pane is hidden while the preview is shown, so the tab is brought into view again when the code comes back.
  useEffect(() => {
    tabStrip.current?.querySelector('.file-tab.selected')?.scrollIntoView({ block: 'nearest', inline: 'start' });
  }, [doc.active, doc.files.length, view]);

  useEffect(() => {
    let disposed = false;
    async function start() {
      let draft: Project | undefined;
      try {
        draft = await loadDraft();
      } catch {
        if (!disposed) setStorage('unavailable');
      }
      if (disposed) return;
      if (draft && latest.current.revision === 0) {
        savedFiles.current = draft.files;
        updateDocument({ ...draft, revision: 1, fileKey: 1 });
      }
      setAutosaveReady(true);
      void run();
    }
    void start();
    return () => {
      disposed = true;
      engine.cancel();
    };
  }, [engine]);

  useEffect(() => {
    if (!autosaveReady) return;
    setStorage('saving');
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void saveDraft({ files: doc.files, active: doc.active, entry: doc.entry })
        .then(() => { if (!cancelled) setStorage('saved'); })
        .catch(() => { if (!cancelled) setStorage('unavailable'); });
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [autosaveReady, doc.files, doc.active, doc.entry]);

  // The editor is rebuilt when another file is shown. Go to the reported line once it exists.
  useEffect(() => {
    if (pendingLine.current === null) return;
    editor.current?.goToLine(pendingLine.current);
    pendingLine.current = null;
  }, [doc.active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.repeat || help.current?.open) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void run();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (latest.current.files.length > 1) void saveProject();
        else saveScad();
      }
    };
    const closeExamples = (event: PointerEvent) => {
      const menu = examplesMenu.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      if (event.target instanceof Node && moreMenu.current && !moreMenu.current.contains(event.target)) setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', closeExamples);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', closeExamples);
    };
  });

  const problem = stage ? undefined : notice.diagnostic;
  const problemFile = problem?.file ?? target;

  return (
    <div className="application">
      <header className="app-header">
        <div className="brand" aria-label="Partscript CAD">
          <span className="brand-icon"><Box size={21} strokeWidth={1.8} /></span>
          <div><h1>Partscript<span> CAD</span></h1><span className="brand-subtitle">Parametric workbench</span></div>
        </div>
        <div className="app-actions">
          <div className="more-menu" ref={moreMenu} onKeyDown={(event) => {
            if (event.key === 'Escape' && moreOpen) {
              setMoreOpen(false);
              moreMenu.current?.querySelector<HTMLElement>('.more-button')?.focus();
            }
          }}>
            <button className="button button-quiet more-button" type="button" title="New, Open, Save and the manual" aria-label="Files and manual" aria-expanded={moreOpen} aria-controls="file-actions" onClick={() => setMoreOpen(!moreOpen)}>
              <Ellipsis size={19}/>
            </button>
            <div className={`file-actions${moreOpen ? ' open' : ''}`} id="file-actions" onClick={() => setMoreOpen(false)}>
              <button className="button button-quiet file-action" type="button" title="Start a new project with one blank file. Add more files with the + beside the tabs." aria-label="New project" disabled={!!stage} onClick={newProject}>
                <FilePlus size={17}/><span>New</span>
              </button>
              <button className="button button-quiet file-action" type="button" title="Open SCAD files, STEP or STL files to import, or a saved project (.zip)" aria-label="Open" disabled={!!stage} onClick={() => fileInput.current?.click()}>
                <FolderOpen size={17}/><span>Open</span>
              </button>
              <button className="button button-quiet file-action" type="button" title="Download the open file as it is" aria-label="Save file" onClick={saveScad}>
                <FileCode2 size={17}/><span>Save file</span>
              </button>
              <button className="button button-quiet file-action" type="button" title="Download every file, imported ones included, as one zip to share or reopen (Ctrl/Cmd+S)" aria-label="Save project" onClick={() => void saveProject()}>
                <FolderArchive size={17}/><span>Save project</span>
              </button>
              <a className="button button-quiet file-action" href="manual.html" target="_blank" rel="noopener" title="Open the manual in a new tab: how to use the page, and how part() and joint() work" aria-label="Manual">
                <BookOpen size={17}/><span>Manual</span>
              </a>
            </div>
          </div>
          <input ref={fileInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-label="Choose SCAD files, STEP or STL files, or a project file" accept={anyFile ? undefined : '.scad,.json,.zip,.step,.stp,.stl,text/plain,application/json,application/zip'} onChange={(event) => {
            const list = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            if (list.length) void openFiles(list);
          }}/>
          <span className="action-divider" />
          {stage ? (
            <button className="button button-run" type="button" onClick={() => engine.cancel()}><Square size={14}/><span>Cancel</span></button>
          ) : (
            <button className="button button-run" type="button" title={`Build ${target} (Ctrl/Cmd+Enter)`} onClick={() => void run()}>
              <Play size={15} fill="currentColor" strokeWidth={1.7}/><span>Run</span><kbd className="run-key">Ctrl ↵</kbd>
            </button>
          )}
          <button className="button button-step" type="button" aria-label="Export STEP" disabled={!canExport} title={canExport ? (preview?.isAssembly ? 'Download the assembly as STEP, in the pose shown' : 'Download the current solid as STEP') : 'Run the current code to enable STEP export'} onClick={() => void exportStep()}>
            {stage === 'export' ? <LoaderCircle className="spin" size={16}/> : <Download size={16}/>}<span>Export STEP</span>
          </button>
        </div>
      </header>

      <nav className="view-switch" aria-label="Show the code or the preview">
        <button type="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}><Box size={17}/><span>Preview</span></button>
        <button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')}>
          <CodeXml size={17}/><span>Code</span>
          {!stage && notice.kind === 'error' && <TriangleAlert className="view-switch-alert" size={15} aria-label="The build failed"/>}
        </button>
      </nav>

      <main className="workspace" data-view={view}>
        <section className="source-pane" aria-label="SCAD editor">
          <div className="source-toolbar">
            <div className="file-tabs" role="tablist" aria-label="Project files" ref={tabStrip}>
              {doc.files.map((file) => {
                const selected = file.name === doc.active;
                const pinned = file.name === doc.entry;
                return (
                  <div key={file.name} className={`file-tab${selected ? ' selected' : ''}${pinned ? ' pinned' : ''}`}>
                    <button type="button" role="tab" aria-selected={selected} className="file-tab-name" title={pinned ? `${file.name} · Run builds this file` : file.name}
                      onClick={() => showFile(file.name)} onDoubleClick={() => renameFile(file.name)}>
                      {pinned ? <Boxes size={14}/> : isAsset(file) ? <FileBox size={14}/> : <CodeXml size={14}/>}<span>{file.name}</span>
                    </button>
                    {selected && (
                      <span className="file-tab-tools">
                        <button type="button" aria-pressed={pinned} title={pinned ? 'Stop building this file on every Run' : 'Build this file on every Run, whichever file is open'} aria-label={pinned ? `Unpin ${file.name}` : `Pin ${file.name} as the file Run builds`} onClick={() => pinFile(file.name)}><Pin size={12}/></button>
                        <button type="button" title="Rename this file" aria-label={`Rename ${file.name}`} disabled={!!stage} onClick={() => renameFile(file.name)}><Pencil size={12}/></button>
                        {doc.files.length > 1 && <button type="button" title="Delete this file" aria-label={`Delete ${file.name}`} disabled={!!stage} onClick={() => deleteFile(file.name)}><X size={13}/></button>}
                      </span>
                    )}
                  </div>
                );
              })}
              <button type="button" className="file-add" title="Add a file to this project" aria-label="Add a file" disabled={!!stage} onClick={addFile}><Plus size={15}/></button>
            </div>
            <details ref={examplesMenu} className="examples" onKeyDown={(event) => {
              if (event.key === 'Escape' && examplesMenu.current?.open) {
                examplesMenu.current.open = false;
                examplesMenu.current.querySelector('summary')?.focus();
              }
            }}>
              <summary aria-label="Examples"><span>Examples</span><ChevronDown size={14}/></summary>
              <div className="examples-popover">
                {exampleProjects.map((example) => (
                  <button type="button" disabled={!!stage} key={example.open} onClick={() => {
                    if (examplesMenu.current) examplesMenu.current.open = false;
                    setView('preview');
                    const files = Object.entries(example.files).map(([name, source]) => ({ name, source }));
                    replaceDocument({ files, active: example.open, entry: files.length > 1 ? example.open : null });
                  }}>
                    {Object.keys(example.files).length > 1 ? <Boxes size={17}/> : <Box size={17}/>}<span><strong>{example.name}</strong><small>{example.description}</small></span>
                  </button>
                ))}
              </div>
            </details>
          </div>
          {isAsset(activeFile) ? (
            <>
              <AssetPanel key={`${doc.fileKey}:${activeFile.name}`} file={activeFile} model={currentBuild ? preview : undefined} busy={!!stage}
                problem={problem && problemFile === activeFile.name ? problem : undefined} onShow={() => showOnItsOwn(activeFile.name)} onShowPart={(path) => showComponent(activeFile.name, path)}/>
              <div className="editor-meter">
                <span>{formatBytes(activeFile.data.byteLength)}</span>
                <span>{target !== activeFile.name && <>Run builds {target}</>}</span>
              </div>
            </>
          ) : (
            <>
              <CodeEditor key={`${doc.fileKey}:${activeFile.name}`} ref={editor} source={activeFile.source} onChange={editSource} onCaret={setCaret} diagnostic={problem && problemFile === activeFile.name ? problem : undefined}/>
              <div className="editor-meter">
                <span>Ln {caret.line}, Col {caret.column}</span>
                <span>{target !== activeFile.name && <>Run builds {target} · </>}{caret.count} lines</span>
              </div>
            </>
          )}
          <section className="output" aria-label="Build output">
            <button type="button" className="output-heading" aria-expanded={outputOpen} aria-controls="build-log" onClick={() => setOutputOpen(!outputOpen)}>
              {outputOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<Terminal size={15}/><span>Build output</span>
              {!outputOpen && notice.kind === 'error' && <TriangleAlert className="output-warning" size={14} />}
            </button>
            {outputOpen && (
              <div className="output-body" id="build-log" role="status" aria-live="polite">
                <div className={`output-message ${stage ? 'working' : notice.kind}`}>
                  {stage ? <LoaderCircle className="spin" size={15}/> : notice.kind === 'error' ? <TriangleAlert size={15}/> : notice.kind === 'success' ? <Check size={15}/> : <ChevronRight size={15}/>}
                  <span>{stage ? stages[stage] : notice.text}</span>
                  {problem && (problem.line || problemFile !== activeFile.name) && doc.files.some((file) => file.name === problemFile) && (
                    <button type="button" className="error-line" onClick={() => showFile(problemFile, problem.line)}>
                      {doc.files.length > 1 ? `${problemFile}${problem.line ? ` · line ${problem.line}` : ''}` : `Line ${problem.line}`}
                    </button>
                  )}
                </div>
                {!stage && currentBuild && preview?.messages.map((message, index) => <div className="echo-message" key={index}>{message}</div>)}
                {!stage && currentBuild && buildLog.map((message, index) => <div className="echo-message" key={`log${index}`}>{message}</div>)}
              </div>
            )}
          </section>
        </section>

        <Viewport model={preview} pose={pose} stale={!currentBuild} running={stage ? stages[stage] : undefined}
          onPose={updatePose} onResetPose={() => preview && updatePose(openingPose(preview.assembly).pose)} onMeasure={measurePicks}/>
      </main>

      <footer className="app-footer">
        <span className="local-status" title="CAD calculations run on this device"><span className="local-dot"/> Local engine</span>
        <span className="autosave-status"><HardDrive size={13}/>{storage === 'saved' ? 'Draft saved on this device' : storage === 'saving' ? 'Saving draft…' : 'Autosave unavailable'}</span>
        <button className="help-button" type="button" onClick={() => help.current?.showModal()}><CircleHelp size={15}/><span>Help &amp; source</span></button>
      </footer>

      <dialog className="help-dialog" ref={help} aria-labelledby="help-title">
        <div className="dialog-heading">
          <Braces size={22}/><h2 id="help-title">Using Partscript</h2>
          <form method="dialog"><button type="submit" className="icon-button" title="Close help" aria-label="Close help"><X size={19}/></button></form>
        </div>
        <div className="dialog-content">
          <p>Change a dimension in the source and press <strong>Run</strong> or <kbd>Ctrl / ⌘ + Enter</kbd>. Inspect the rebuilt model and choose <strong>Export STEP</strong> to download it.</p>
          <p>The <a href="manual.html" target="_blank" rel="noopener">manual</a> covers the page, the OpenSCAD you need, every argument of <code>part()</code> and <code>joint()</code>, and what to do when a build fails. This dialog is the short version.</p>
          <dl>
            <dt>Shapes and operations</dt>
            <dd>Everything OpenSCAD can render builds. Boxes, cylinders and spheres combined with <code>translate()</code>, <code>rotate()</code>, <code>mirror()</code>, <code>scale()</code>, <code>union()</code>, <code>difference()</code> and <code>intersection()</code> export with true curves, and so does <code>linear_extrude()</code> of circles, squares, polygons and their unions, differences, <code>hull()</code> and <code>offset()</code>, so holes are round in STEP. Any other part, such as <code>hull()</code> of solids, <code>rotate_extrude()</code>, <code>minkowski()</code>, <code>polyhedron()</code> or a twisted extrusion, is <em>faceted</em>: it shows and exports as a solid with flat faces, and the build output says which parts and why. Set <code>$fn</code> only when you want flat sides: a cylinder or circle with <code>$fn</code> is a polygon in STEP, so its hole is not round, and the build output names the file and line. Leave <code>$fn</code> out for true cylinders.</dd>
            <dt>Parameters</dt>
            <dd>Use OpenSCAD variables, functions, local modules, loops and conditionals. Keep the <code>.scad</code> files for future edits.</dd>
            <dt>Assemblies</dt>
            <dd>Write each part in its own file with its pivot at the origin. In one more file, list them with <code>part("arm", "arm.scad");</code>, or write a part's shapes in place with <code>part("arm") {'{'} … {'}'}</code>, and connect them with <code>joint("lift", type = "hinge", parent = "base", child = "arm", at = [0, 0, 30], axis = [0, 1, 0], limits = [0, 90]);</code>. Types are <code>"fixed"</code>, <code>"hinge"</code> in degrees and <code>"slider"</code> in millimetres. <code>at</code> and <code>rot</code> place the joint in the parent's coordinates. Move joints with the sliders in the preview, or press play on one to run it through its travel. STEP exports the pose shown, with one named part per <code>part()</code>. To see inside, untick a part in <strong>Parts</strong> above the preview. That hides it in the preview only, and STEP still has every part. A cover you want to hide on its own needs its own <code>part()</code>.</dd>
            <dt>Linkages and closed loops</dt>
            <dd>A joint between two parts that are already connected closes a loop, as the fourth hinge of a four-bar does. Give it <code>child_at = [x, y, z]</code> to say where the joint sits on the child. Moving any joint in the loop moves the others, and a move stops at a dead point. In a loop, the first joint with a <code>value</code> is held and other values are starting guesses that pick which way the linkage assembles. Open the <strong>Crank-rocker linkage</strong> example.</dd>
            <dt>Gears and cams</dt>
            <dd>Give a joint <code>follow = "crank"</code> to make it take its value from another joint. A gear pair is a <code>ratio</code>, as in <code>ratio = -2</code>, and <code>offset</code> is added. A cam or any formula is a <code>table</code> of <code>[input, output]</code> rows, such as <code>table = [for (a = [0 : 1 : 360]) [a, my_height(a)]]</code>, read in straight lines between rows. A table needs two to 5,000 rows with increasing inputs, and its output stays at the first or last row past either end. A hinge with no <code>limits</code> that goes round and round wraps into a table whose inputs run exactly 360 apart. A follower takes no <code>limits</code> or <code>value</code>, shows as a read-only row, and cannot be part of a loop. The joint it follows can be. Use whole-number ratios on a hinge that turns fully, or the follower jumps when the driver comes round. Gear teeth are not simulated. Open the <strong>Gears and a cam</strong> example.</dd>
            <dt>One file, many parts</dt>
            <dd>To make an assembly from a design kept in one file, <code>include</code> it, add <code>part = "none";</code> so it draws nothing of its own, then call its modules inside <code>part("name") ...</code>. Every part comes from a single evaluation, and an edit rebuilds only the parts that changed. Do not wrap <code>part()</code> in <code>translate()</code>; use <code>at</code> and <code>rot</code>, or move the shapes inside the braces.</dd>
            <dt>BOSL2</dt>
            <dd>Gears, threads, screws and more come from the BOSL2 library. Start the file with <code>include &lt;BOSL2/std.scad&gt;</code>, add the file you need such as <code>include &lt;BOSL2/gears.scad&gt;</code>, then call <code>spur_gear(mod = 2, teeth = 20, thickness = 8);</code>. The library is about 1.2 MB and downloads the first time a project includes it during a visit. Each run that includes it takes about a quarter of a second longer, so write many parts in one file with <code>part("name") ...</code> rather than one file per part. Gears are exact; threads are faceted, so their STEP has flat faces.</dd>
            <dt>Imported STEP and STL files</dt>
            <dd>Choose <strong>Open</strong> and pick a <code>.step</code>, <code>.stp</code> or <code>.stl</code> file, such as a motor or a bearing from GrabCAD or a supplier. It becomes a tab you can look at with <strong>Show on its own</strong> and measure. Use it as a part with <code>part("motor", "motor.step");</code> and connect it with joints like any other part. A STEP that holds an assembly lists its parts in its tab: <code>part("arm", "robot.step", component = "arm");</code> or <code>body = 2</code> takes one of them, in the place and colour the file gives it. A STEP keeps its true curves and exports as it came. An STL is a mesh with no units, read as millimetres, so it exports with flat faces. Inside a <code>.scad</code> file, <code>import("bracket.stl");</code> reads an STL of the project too. Files from a CAD program's own format (<code>.sldprt</code>, <code>.ipt</code>, <code>.f3d</code>, <code>.x_t</code>) and IGES files cannot be read, so download or export the STEP version. One file can be up to 40 MB and a project up to 120 MB of them.</dd>
            <dt>Sharing values</dt>
            <dd>Put shared dimensions in a file such as <code>params.scad</code> and start each part with <code>include &lt;params.scad&gt;</code>. Pin a tab to keep <strong>Run</strong> building the assembly while you edit a part. <strong>New</strong> starts a blank project with one file, and the <strong>+</strong> beside the tabs adds more. <strong>Save project</strong> downloads every file, imported ones included, as one zip a teammate can open.</dd>
            <dt>On a phone</dt>
            <dd>The page shows the preview or the code, one at a time: use the <strong>Preview</strong> and <strong>Code</strong> buttons under the header. New, Open, Save and the manual are behind <strong>⋯</strong>. <strong>Joints</strong> opens a strip under the model. Drag to turn the model, pinch to zoom, and tap in <strong>Measure</strong> where a mouse would click.</dd>
            <dt>Model limits</dt>
            <dd>In millimetres. A part must have volume, and a file that draws only flat 2D shapes needs <code>linear_extrude()</code>. Collision checks are unavailable. Libraries other than BOSL2 are unavailable in this version, and <code>text()</code> fails because no fonts are bundled. OpenSCAD evaluates geometry to six significant digits before the solid is built.</dd>
          </dl>
          <div className="dialog-actions">
            <a className="button button-step" href={`${import.meta.env.BASE_URL}source/partscript-cad-source.zip`} download><Download size={16}/> Download source</a>
            <a className="button button-quiet" href={`${import.meta.env.BASE_URL}licenses/NOTICES.txt`} target="_blank" rel="noreferrer">Licenses</a>
          </div>
        </div>
      </dialog>
    </div>
  );
}

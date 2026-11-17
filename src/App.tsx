import { Box, Boxes, Braces, Check, ChevronDown, ChevronRight, CircleHelp, CodeXml, Download, FileCode2, FolderArchive, FolderOpen, HardDrive, LoaderCircle, Pencil, Pin, Play, Plus, Square, Terminal, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CodeEditor, type EditorControl } from './components/CodeEditor.tsx';
import { Viewport } from './components/Viewport.tsx';
import { clampJoint, defaultPose, fileNamePattern, structureOf, type AssemblySpec } from './engine/assembly.ts';
import { BrowserGeometryEngine } from './engine/client.ts';
import { loopStates, openingPose, settlePose } from './engine/kinematics.ts';
import { CadError, MAX_PROJECT_FILES, MAX_SOURCE_BYTES, type BuildStage, type Diagnostic, type ModelPreview, type Pose } from './engine/protocol.ts';
import { loadDraft, saveDraft } from './drafts.ts';
import { exampleProjects } from './examples.ts';
import { readProject, scadFilename, serializeProject, toFiles, uniqueName, type Project, type ProjectFile } from './project.ts';

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
  if (!model.isAssembly) return `Built one solid in ${elapsed(model.buildMs)}.`;
  const kept = parts.length > 1 && model.rebuilt < model.meshes.length ? ` ${count(model.rebuilt, 'solid')} rebuilt, the rest reused.` : '';
  const loops = structureOf(model.assembly).closures.length;
  return `Built ${count(parts.length, 'part')} and ${count(joints.length, 'joint')}${loops ? ` with ${count(loops, 'closed loop')}` : ''} in ${elapsed(model.buildMs)}.${kept}`;
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

function sameFiles(a: ProjectFile[], b: ProjectFile[]) {
  return a.length === b.length && a.every((file, i) => file.name === b[i].name && file.source === b[i].source);
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
  const [caret, setCaret] = useState({ line: 1, column: 1, count: 1 });
  const [stage, setStage] = useState<BuildStage | null>(null);
  const [preview, setPreview] = useState<ModelPreview>();
  const [pose, setPose] = useState<Pose>({});
  const shownPose = useRef(pose);
  const shownAssembly = useRef<AssemblySpec | undefined>(undefined);
  const [builtRevision, setBuiltRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice>({ kind: 'idle', text: 'Opening the workspace…' });
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [storage, setStorage] = useState<'saving' | 'saved' | 'unavailable'>('saving');
  const [outputOpen, setOutputOpen] = useState(true);
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

  async function run(snapshot = latest.current) {
    if (busy.current) return;
    busy.current = true;
    setBuiltRevision(null);
    setStage('load');
    const entry = snapshot.entry ?? snapshot.active;
    try {
      const result = await engine.build(toFiles(snapshot), entry, snapshot.revision, setStage);
      const opening = carryPose(result.assembly, shownAssembly.current, shownPose.current);
      const openLoop = opening.closed ? undefined : openLoopText(result.assembly, opening.pose);
      updatePose(opening.pose);
      shownAssembly.current = result.assembly;
      setPreview(result);
      setBuiltRevision(snapshot.revision);
      // Run keeps building an assembly while its part files are being edited.
      if (result.isAssembly && latest.current.entry === null && latest.current.files.some((file) => file.name === entry)) {
        updateDocument({ ...latest.current, entry });
      }
      if (openLoop) setOutputOpen(true);
      setNotice(snapshot.revision === latest.current.revision
        ? (openLoop ? { kind: 'error', text: `${builtText(result)} ${openLoop}` } : { kind: 'success', text: builtText(result) })
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
    download(file.source, file.name, 'text/plain;charset=utf-8');
    if (current.files.length === 1) savedFiles.current = current.files;
    if (!busy.current) setNotice({ kind: 'success', text: `Saved ${file.name}.` });
  }

  function saveProject() {
    const current = latest.current;
    const name = `${(current.entry ?? current.active).replace(/\.scad$/i, '')}.partscript.json`;
    download(serializeProject(current), name, 'application/json');
    savedFiles.current = current.files;
    if (!busy.current) setNotice({ kind: 'success', text: `Saved ${name} with ${count(current.files.length, 'file')}.` });
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
    const name = scadFilename(typed);
    if (!fileNamePattern.test(name)) {
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
    const source = `// ${name.replace(/\.scad$/i, '')} · dimensions in mm\ncube([20, 20, 10]);\n`;
    editProject({ files: [...before.files, { name, source }], active: name }, `Added ${name}.`);
  }

  function renameFile(old: string) {
    const before = latest.current;
    if (busy.current) return;
    const name = askName(`Rename ${old}`, old, old);
    if (!name || name === old) return;
    const used = before.files.some((file) => file.name !== old && file.source.includes(old));
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
      const texts: ProjectFile[] = [];
      for (const file of list) {
        if (file.size > MAX_SOURCE_BYTES * 8) throw new CadError(`${file.name} is too large to open.`);
        const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
        if (source.includes('\0')) throw new CadError(`${file.name} is not plain text.`);
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
        texts.push({ name: scadFilename(file.name), source });
      }
      if (!texts.length) return;
      const before = latest.current;
      // One file opens on its own, as before. Several files join the current project.
      if (texts.length === 1 && before.files.length === 1) {
        replaceDocument({ files: texts, active: texts[0].name, entry: null });
        return;
      }
      const replaced = texts.filter((file) => before.files.some((item) => item.name === file.name));
      if (replaced.length && !window.confirm(`Replace ${replaced.map((file) => file.name).join(', ')} in this project?`)) return;
      const files = [...before.files.filter((file) => !texts.some((item) => item.name === file.name)), ...texts];
      if (files.length > MAX_PROJECT_FILES) throw new CadError(`A project can hold ${MAX_PROJECT_FILES} files.`);
      editProject({ files, active: texts[0].name }, `Added ${count(texts.length, 'file')} to the project.`);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof CadError ? error.message : 'Could not open this file as UTF-8 text.' });
      setOutputOpen(true);
    }
  }

  function editSource(source: string) {
    const before = latest.current;
    const file = before.files.find((item) => item.name === before.active);
    if (!file || source === file.source) return;
    updateDocument({
      ...before, revision: before.revision + 1,
      files: before.files.map((item) => (item === file ? { ...item, source } : item)),
    });
    setNotice({ kind: 'idle', text: 'Code changed. Run to update the preview.' });
  }

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
        if (latest.current.files.length > 1) saveProject();
        else saveScad();
      }
    };
    const closeExamples = (event: PointerEvent) => {
      const menu = examplesMenu.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
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
          <button className="button button-quiet file-action" type="button" title="Open SCAD files or a saved project" aria-label="Open" disabled={!!stage} onClick={() => fileInput.current?.click()}>
            <FolderOpen size={17}/><span>Open</span>
          </button>
          <input ref={fileInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-label="Choose SCAD files or a project file" accept=".scad,.json,text/plain,application/json" onChange={(event) => {
            const list = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            if (list.length) void openFiles(list);
          }}/>
          <button className="button button-quiet file-action" type="button" title="Download the open SCAD file" aria-label="Save file" onClick={saveScad}>
            <FileCode2 size={17}/><span>Save file</span>
          </button>
          <button className="button button-quiet file-action" type="button" title="Download every file as one project file to share or reopen (Ctrl/Cmd+S)" aria-label="Save project" onClick={saveProject}>
            <FolderArchive size={17}/><span>Save project</span>
          </button>
          <span className="action-divider" />
          {stage ? (
            <button className="button button-run" type="button" onClick={() => engine.cancel()}><Square size={14}/><span>Cancel</span></button>
          ) : (
            <button className="button button-run" type="button" title={`Build ${target} (Ctrl/Cmd+Enter)`} onClick={() => void run()}>
              <Play size={15} fill="currentColor" strokeWidth={1.7}/><span>Run</span><kbd className="run-key">Ctrl ↵</kbd>
            </button>
          )}
          <button className="button button-step" type="button" disabled={!canExport} title={canExport ? (preview?.isAssembly ? 'Download the assembly as STEP, in the pose shown' : 'Download the current solid as STEP') : 'Run the current code to enable STEP export'} onClick={() => void exportStep()}>
            {stage === 'export' ? <LoaderCircle className="spin" size={16}/> : <Download size={16}/>}<span>Export STEP</span>
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="source-pane" aria-label="SCAD editor">
          <div className="source-toolbar">
            <div className="file-tabs" role="tablist" aria-label="Project files">
              {doc.files.map((file) => {
                const selected = file.name === doc.active;
                const pinned = file.name === doc.entry;
                return (
                  <div key={file.name} className={`file-tab${selected ? ' selected' : ''}${pinned ? ' pinned' : ''}`}>
                    <button type="button" role="tab" aria-selected={selected} className="file-tab-name" title={pinned ? `${file.name} · Run builds this file` : file.name}
                      onClick={() => showFile(file.name)} onDoubleClick={() => renameFile(file.name)}>
                      {pinned ? <Boxes size={14}/> : <CodeXml size={14}/>}<span>{file.name}</span>
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
                    const files = Object.entries(example.files).map(([name, source]) => ({ name, source }));
                    replaceDocument({ files, active: example.open, entry: files.length > 1 ? example.open : null });
                  }}>
                    {Object.keys(example.files).length > 1 ? <Boxes size={17}/> : <Box size={17}/>}<span><strong>{example.name}</strong><small>{example.description}</small></span>
                  </button>
                ))}
              </div>
            </details>
          </div>
          <CodeEditor key={`${doc.fileKey}:${activeFile.name}`} ref={editor} source={activeFile.source} onChange={editSource} onCaret={setCaret} diagnostic={problem && problemFile === activeFile.name ? problem : undefined}/>
          <div className="editor-meter">
            <span>Ln {caret.line}, Col {caret.column}</span>
            <span>{target !== activeFile.name && <>Run builds {target} · </>}{caret.count} lines</span>
          </div>
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
              </div>
            )}
          </section>
        </section>

        <Viewport model={preview} pose={pose} stale={!currentBuild} running={stage ? stages[stage] : undefined}
          onPose={updatePose} onResetPose={() => preview && updatePose(openingPose(preview.assembly).pose)}/>
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
          <dl>
            <dt>Shapes and operations</dt>
            <dd><code>cube()</code>, <code>cylinder()</code>, <code>sphere()</code>, <code>translate()</code>, <code>rotate()</code>, <code>mirror()</code>, <code>union()</code>, <code>difference()</code>, <code>intersection()</code>.</dd>
            <dt>Parameters</dt>
            <dd>Use OpenSCAD variables, functions, local modules, loops and conditionals. Keep the <code>.scad</code> files for future edits.</dd>
            <dt>Assemblies</dt>
            <dd>Write each part in its own file with its pivot at the origin. In one more file, list them with <code>part("arm", "arm.scad");</code> and connect them with <code>joint("lift", type = "hinge", parent = "base", child = "arm", at = [0, 0, 30], axis = [0, 1, 0], limits = [0, 90]);</code>. Types are <code>"fixed"</code>, <code>"hinge"</code> in degrees and <code>"slider"</code> in millimetres. <code>at</code> and <code>rot</code> place the joint in the parent's coordinates. Move joints with the sliders in the preview, or press play on one to run it through its travel. STEP exports the pose shown, with one named part per <code>part()</code>.</dd>
            <dt>Linkages and closed loops</dt>
            <dd>A joint between two parts that are already connected closes a loop, as the fourth hinge of a four-bar does. Give it <code>child_at = [x, y, z]</code> to say where the joint sits on the child. Moving any joint in the loop moves the others, and a move stops at a dead point. In a loop, the first joint with a <code>value</code> is held and other values are starting guesses that pick which way the linkage assembles. Open the <strong>Crank-rocker linkage</strong> example.</dd>
            <dt>Sharing values</dt>
            <dd>Put shared dimensions in a file such as <code>params.scad</code> and start each part with <code>include &lt;params.scad&gt;</code>. Pin a tab to keep <strong>Run</strong> building the assembly while you edit a part. <strong>Save project</strong> downloads every file as one file a teammate can open.</dd>
            <dt>Model limits</dt>
            <dd>One connected solid per part file, in millimetres. Collision checks and gears are unavailable. External libraries, imports and facet overrides are unavailable. OpenSCAD evaluates geometry to six significant digits before the solid is built.</dd>
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

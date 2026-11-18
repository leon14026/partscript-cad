import { Check, Copy, Eye, FileBox, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { assetFormat, formatBytes, stemOf } from '../engine/assets.ts';
import type { Diagnostic, ModelPreview, StepComponent } from '../engine/protocol.ts';
import type { AssetFile } from '../project.ts';

/** A part name the assembly reader accepts: letters, digits, _ . and -, starting with a letter. */
function partName(file: string) {
  const stem = stemOf(file).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z]+/, '');
  return stem || 'part';
}

/** The part() line for one component of a STEP file. */
const componentLine = (file: string, path: string) => `part("${partName(path)}", "${file}", component = "${path.replace(/"/g, '')}");`;

const sizeText = (min: number[], max: number[]) =>
  [0, 1, 2].map((k) => (Math.round((max[k] - min[k]) * 100) / 100).toLocaleString('en-US')).join(' × ');

interface Props {
  file: AssetFile;
  /** The last build, when it is of the code on screen. */
  model?: ModelPreview;
  /** The build error that names this file, if there is one. */
  problem?: Diagnostic;
  busy: boolean;
  /** Build this file alone, to look at it and measure it, whatever file Run builds. */
  onShow(): void;
  /** Build one component of this STEP file alone. */
  onShowPart(path: string): void;
}

/** Shown in the place of the editor when an imported STEP or STL is the open file. */
export function AssetPanel({ file, model, problem, busy, onShow, onShowPart }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const format = assetFormat(file.name) === 'stl' ? 'STL' : 'STEP';
  // The facts below are of the whole file, so they come from a part that uses all of it.
  const index = model?.assembly.parts.findIndex((part) => part.file === file.name && part.component === undefined && part.body === undefined) ?? -1;
  const mesh = model && index >= 0 ? model.meshes[model.partMesh[index]] : undefined;
  const structure = model?.steps?.[file.name];
  const usedInPart = !mesh && !!structure && !!model?.assembly.parts.some((part) => part.file === file.name);
  const components = structure?.components ?? [];
  const line = `part("${partName(file.name)}", "${file.name}");`;

  // A file that could not be read says nothing about its format or geometry, only its size.
  const facts: [string, string][] = problem ? [['Size', formatBytes(file.data.byteLength)]]
    : [['Format', format === 'STL' ? 'STL mesh' : 'STEP, exact geometry'], ['Size', formatBytes(file.data.byteLength)]];
  if (mesh && !problem) {
    if (format === 'STEP') facts.push(['Bodies', String(mesh.bodies ?? 1)]);
    if (format === 'STEP' && components.length) facts.push(['Components', String(components.length + (structure?.unlisted ?? 0))]);
    facts.push(['Bounding box', `${sizeText(mesh.bounds.min, mesh.bounds.max)} mm`]);
    facts.push(['Volume', `${(Math.round(mesh.volume / 10) / 100).toLocaleString('en-US')} cm³`]);
    facts.push([format === 'STL' ? 'Triangles' : 'Preview triangles', (mesh.indices.length / 3).toLocaleString('en-US')]);
  }

  if (!mesh && !problem && structure) {
    facts.push(['Bodies', String(structure.bodies)]);
    if (components.length) facts.push(['Components', String(components.length + structure.unlisted)]);
  }
  const copy = (key: string, line: string) => {
    void navigator.clipboard.writeText(line).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied((now) => (now === key ? null : now)), 1600);
    }).catch(() => {});
  };

  return (
    <div className="asset-panel">
      <div className="asset-heading"><FileBox size={20}/><div><strong>{file.name}</strong><span>Imported file · kept exactly as it was opened</span></div></div>
      {problem && <div className="asset-problem"><TriangleAlert size={15}/><span>{problem.message}</span></div>}
      <dl className="asset-facts">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {!mesh && !problem && usedInPart && <p className="asset-note">The last build used parts of this file. Press <strong>Show on its own</strong> to see all of it.</p>}
      {!mesh && !problem && !usedInPart && <p className="asset-note">{model ? 'The last build did not use this file.' : 'Nothing is built yet.'} Press <strong>Show on its own</strong> to read it, or put it in an assembly with the line below.</p>}
      {format === 'STL' && <p className="asset-note">An STL has no units. It is read as millimetres. It shows and exports with flat faces, because a mesh has no true curves.</p>}
      {format === 'STEP' && mesh && <p className="asset-note">Units are converted to millimetres when the file is read.</p>}
      {problem && <p className="asset-note">Delete this file with the × on its tab, then open a corrected copy. Use <strong>Save file</strong> to download what was opened.</p>}
      {!problem && <>
      <div className="asset-actions">
        <button type="button" className="button button-quiet" disabled={busy} onClick={onShow}><Eye size={16}/><span>Show on its own</span></button>
        <button type="button" className="button button-quiet" onClick={() => copy('file', line)}>{copied === 'file' ? <Check size={16}/> : <Copy size={16}/>}<span>{copied === 'file' ? 'Copied' : 'Copy the part line'}</span></button>
      </div>
      {format === 'STEP' && components.length >= 2 && <ComponentList file={file.name} components={components} unlisted={structure?.unlisted ?? 0} busy={busy} copied={copied} onShow={onShowPart} onCopy={copy}/>}
      <p className="asset-line"><code>{line}</code></p>
      <p className="asset-note">Paste that line into an assembly file, then connect the part with <code>joint()</code> like any other. Use <strong>Save file</strong> to download the original.</p>
      </>}
    </div>
  );
}

const sizeOf = (c: StepComponent) => sizeText(c.bounds.min, c.bounds.max);
const swatch = (color?: [number, number, number]) => (color ? `rgb(${color.map((v) => Math.round(v * 255)).join(',')})` : 'transparent');

interface ListProps {
  file: string;
  components: StepComponent[];
  unlisted: number;
  busy: boolean;
  copied: string | null;
  onShow(path: string): void;
  onCopy(key: string, line: string): void;
}

/** What the file holds, one row for each component, so one can be shown alone or named in part(). */
function ComponentList({ file, components, unlisted, busy, copied, onShow, onCopy }: ListProps) {
  return (
    <section className="asset-parts" aria-label="Components in this file">
      <h3>Parts in this file</h3>
      <ul>
        {components.map((component) => (
          <li key={component.path} style={{ paddingLeft: 8 + component.depth * 16 }}>
            <span className="asset-swatch" style={{ background: swatch(component.color) }} aria-hidden="true"/>
            <span className="asset-part-text">
              <strong>{component.name}</strong>
              <span>{component.bodies === 1 ? '1 body' : `${component.bodies} bodies`}{component.bodies ? ` · ${sizeOf(component)} mm` : ''}{component.bodies ? ` · body ${component.firstBody}${component.bodies > 1 ? ` to ${component.firstBody + component.bodies - 1}` : ''}` : ''}</span>
            </span>
            <button type="button" className="button button-quiet" disabled={busy || !component.bodies} title={`Show ${component.path} on its own`} aria-label={`Show ${component.path} on its own`} onClick={() => onShow(component.path)}><Eye size={15}/></button>
            <button type="button" className="button button-quiet" title={`Copy the part line for ${component.path}`} aria-label={`Copy the part line for ${component.path}`} onClick={() => onCopy(component.path, componentLine(file, component.path))}>{copied === component.path ? <Check size={15}/> : <Copy size={15}/>}</button>
          </li>
        ))}
      </ul>
      {unlisted > 0 && <p className="asset-note">{unlisted.toLocaleString('en-US')} more components are not listed. Name them in part() with their path, or pick a solid with body.</p>}
      <p className="asset-note">A part keeps the place the file gives it, so the assembly opens as it was saved. Joints are not in a STEP file: add them with <code>joint()</code>.</p>
    </section>
  );
}

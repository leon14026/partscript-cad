import { Check, Copy, Eye, FileBox, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { assetFormat, formatBytes, stemOf } from '../engine/assets.ts';
import type { Diagnostic, ModelPreview } from '../engine/protocol.ts';
import type { AssetFile } from '../project.ts';

/** A part name the assembly reader accepts: letters, digits, _ . and -, starting with a letter. */
function partName(file: string) {
  const stem = stemOf(file).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z]+/, '');
  return stem || 'part';
}

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
}

/** Shown in the place of the editor when an imported STEP or STL is the open file. */
export function AssetPanel({ file, model, problem, busy, onShow }: Props) {
  const [copied, setCopied] = useState(false);
  const format = assetFormat(file.name) === 'stl' ? 'STL' : 'STEP';
  const index = model?.assembly.parts.findIndex((part) => part.file === file.name) ?? -1;
  const mesh = model && index >= 0 ? model.meshes[model.partMesh[index]] : undefined;
  const line = `part("${partName(file.name)}", "${file.name}");`;

  const facts: [string, string][] = [['Format', format === 'STL' ? 'STL mesh' : 'STEP, exact geometry'], ['Size', formatBytes(file.data.byteLength)]];
  if (mesh) {
    if (format === 'STEP') facts.push(['Bodies', String(mesh.bodies ?? 1)]);
    facts.push(['Bounding box', `${sizeText(mesh.bounds.min, mesh.bounds.max)} mm`]);
    facts.push(['Volume', `${(Math.round(mesh.volume / 10) / 100).toLocaleString('en-US')} cm³`]);
    facts.push([format === 'STL' ? 'Triangles' : 'Preview triangles', (mesh.indices.length / 3).toLocaleString('en-US')]);
  }

  return (
    <div className="asset-panel">
      <div className="asset-heading"><FileBox size={20}/><div><strong>{file.name}</strong><span>Imported file · kept exactly as it was opened</span></div></div>
      {problem && <div className="asset-problem"><TriangleAlert size={15}/><span>{problem.message}</span></div>}
      <dl className="asset-facts">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {!mesh && !problem && <p className="asset-note">{model ? 'The last build did not use this file.' : 'Nothing is built yet.'} Press <strong>Show on its own</strong> to read it, or put it in an assembly with the line below.</p>}
      {format === 'STL' && <p className="asset-note">An STL has no units. It is read as millimetres. It shows and exports with flat faces, because a mesh has no true curves.</p>}
      {format === 'STEP' && mesh && <p className="asset-note">Units are converted to millimetres when the file is read.</p>}
      <div className="asset-actions">
        <button type="button" className="button button-quiet" disabled={busy} onClick={onShow}><Eye size={16}/><span>Show on its own</span></button>
        <button type="button" className="button button-quiet" onClick={() => {
          void navigator.clipboard.writeText(line).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }).catch(() => {});
        }}>{copied ? <Check size={16}/> : <Copy size={16}/>}<span>{copied ? 'Copied' : 'Copy the part line'}</span></button>
      </div>
      <p className="asset-line"><code>{line}</code></p>
      <p className="asset-note">Paste that line into an assembly file, then connect the part with <code>joint()</code> like any other. Use <strong>Save file</strong> to download the original.</p>
    </div>
  );
}

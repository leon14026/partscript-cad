import { Download, LoaderCircle, PencilRuler, X } from 'lucide-react';
import { forwardRef, useEffect, useMemo, useState } from 'react';
import { exportDrawings, type DrawingFile, type DrawingFormat } from '../drawing/export.ts';
import { sheetSizes } from '../drawing/layout.ts';
import { titleFieldLimit } from '../drawing/options.ts';
import { buildSheets, type SheetContext } from '../drawing/sheet.ts';
import { sheetToSvg } from '../drawing/svg.ts';
import type { DrawingOptions, DrawingResult, SheetSize } from '../drawing/types.ts';

export type DrawingState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'ready'; result: DrawingResult }
  | { status: 'error'; message: string };

interface Props {
  state: DrawingState;
  options: DrawingOptions;
  /** Names the downloaded zip when there are several sheets. */
  project: string;
  context: SheetContext;
  onOptions: (options: DrawingOptions) => void;
  onDownload: (file: DrawingFile) => void;
}

/** A sheet shown as an image. An SVG in an image cannot run script, so part names that came from the user's code are harmless. */
function SheetImage({ svg, label }: { svg: string; label: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const made = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [svg]);
  return url ? <img className="sheet-image" src={url} alt={label}/> : null;
}

export const DrawingDialog = forwardRef<HTMLDialogElement, Props>(function DrawingDialog({ state, options, project, context, onOptions, onDownload }, ref) {
  const [chosen, setChosen] = useState(0);
  const [all, setAll] = useState(true);
  const sheets = useMemo(() => (state.status === 'ready' ? buildSheets(state.result, options, context) : []), [state, options, context]);
  const sheet = sheets[Math.min(chosen, sheets.length - 1)];
  const svg = useMemo(() => (sheet ? sheetToSvg(sheet) : ''), [sheet]);
  const parts = state.status === 'ready' ? state.result.parts : [];
  /** The assembly sheet, when there is one, comes before the sheets of the parts. */
  const lead = state.status === 'ready' && state.result.assembly ? 1 : 0;

  useEffect(() => setChosen(0), [state]);

  const set = (change: Partial<DrawingOptions>) => onOptions({ ...options, ...change });
  const setTitle = (change: Partial<DrawingOptions['title']>) => onOptions({ ...options, title: { ...options.title, ...change } });
  const download = (format: DrawingFormat) => onDownload(exportDrawings(all ? sheets : [sheet], format, project));

  return (
    <dialog className="help-dialog drawing-dialog" ref={ref} aria-labelledby="drawing-title">
      <div className="dialog-heading">
        <PencilRuler size={22}/><h2 id="drawing-title">Drawing</h2>
        <form method="dialog"><button type="submit" className="icon-button" title="Close" aria-label="Close drawing"><X size={19}/></button></form>
      </div>
      <div className="dialog-content">
        {state.status === 'working' && <p className="drawing-status"><LoaderCircle className="spin" size={16}/> Reading the parts and drawing them…</p>}
        {state.status === 'error' && <p className="drawing-status drawing-error" role="alert">{state.message}</p>}
        {state.status === 'idle' && <p className="drawing-status">Run the code, then choose Drawing.</p>}
        <div className="drawing-layout">
        <div className="drawing-side">
        <div className="drawing-form">
          <label>Sheet
            <select value={options.size} onChange={(event) => set({ size: event.target.value as SheetSize })}>
              {Object.entries(sheetSizes).map(([key, size]) => <option key={key} value={key}>{size.label}</option>)}
            </select>
          </label>
          <label>Projection
            <select value={options.projection} onChange={(event) => set({ projection: event.target.value as DrawingOptions['projection'] })}>
              <option value="third">Third angle</option>
              <option value="first">First angle</option>
            </select>
          </label>
          <label>Hidden lines
            <select value={options.hidden} onChange={(event) => set({ hidden: event.target.value as DrawingOptions['hidden'] })}>
              <option value="auto">When there are few</option>
              <option value="on">Always</option>
              <option value="off">Never</option>
            </select>
          </label>
          <label>Drawn by
            <input value={options.title.drawnBy} maxLength={titleFieldLimit} onChange={(event) => setTitle({ drawnBy: event.target.value })}/>
          </label>
          <label>Date
            <input value={options.title.date} maxLength={titleFieldLimit} placeholder="YYYY-MM-DD" onChange={(event) => setTitle({ date: event.target.value })}/>
          </label>
          <label>Revision
            <input value={options.title.revision} maxLength={titleFieldLimit} onChange={(event) => setTitle({ revision: event.target.value })}/>
          </label>
          <label className="drawing-wide">Material
            <input value={options.title.material} maxLength={titleFieldLimit} placeholder="6061-T6 ALUMINUM" onChange={(event) => setTitle({ material: event.target.value })}/>
          </label>
        </div>
        {sheet && sheets.length > 1 && (
          <label className="drawing-part">Sheet shown
            <select value={chosen} onChange={(event) => setChosen(Number(event.target.value))}>
              {sheets.map((item, i) => (
                <option key={item.name + i} value={i}>
                  {i < lead ? `Assembly: ${item.name.replace(/_assembly$/, '')}` : item.name}{i >= lead && parts[i - lead].quantity > 1 ? ` (×${parts[i - lead].quantity})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {sheet && sheet.notes.length > 0 && (
          <div className="drawing-notes">
            <h3>Not on this sheet</h3>
            <ul>{sheet.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>
          </div>
        )}
        {sheet && (
          <div className="dialog-actions">
            <button className="button button-step" type="button" onClick={() => download('pdf')}><Download size={16}/> PDF</button>
            <button className="button button-quiet button-outline" type="button" onClick={() => download('dxf')}><Download size={16}/> DXF</button>
            <button className="button button-quiet button-outline" type="button" onClick={() => download('svg')}><Download size={16}/> SVG</button>
            {sheets.length > 1 && (
              <label className="drawing-all"><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)}/> All {sheets.length} sheets</label>
            )}
          </div>
        )}
        </div>
        <div className="drawing-sheet">
          {sheet && <SheetImage svg={svg} label={`Drawing sheet for ${sheet.name} at scale ${sheet.scale}`}/>}
        </div>
        </div>
      </div>
    </dialog>
  );
});

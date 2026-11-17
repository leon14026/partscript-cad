import { Box, Boxes, Expand, Grid3X3, Layers2, LoaderCircle, Mouse, MoveHorizontal, RotateCcw, RotateCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clampJoint, poseBounds, type JointSpec } from '../engine/assembly.ts';
import type { ModelPreview, Pose } from '../engine/protocol.ts';
import { createViewer, type ViewAngle } from './viewer.ts';

const angles: { angle: ViewAngle; label: string; name: string }[] = [
  { angle: 'iso', label: 'ISO', name: 'Isometric' },
  { angle: 'top', label: 'TOP', name: 'Top' },
  { angle: 'front', label: 'FRONT', name: 'Front' },
  { angle: 'right', label: 'RIGHT', name: 'Right' },
];
const measure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4, useGrouping: false });

function JointControl({ joint, value, onChange }: { joint: JointSpec; value: number; onChange(value: number, dragging: boolean): void }) {
  const [low, high] = joint.limits;
  const unit = joint.type === 'hinge' ? '°' : 'mm';
  const step = high - low > 20 ? 1 : 0.1;
  const id = `joint-${joint.name}`;
  // The number box keeps what is typed until it is a value the joint can take.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <div className="joint">
      <label htmlFor={id} title={`${joint.parent} → ${joint.child}`}>
        {joint.type === 'hinge' ? <RotateCw size={13}/> : <MoveHorizontal size={13}/>}<span>{joint.name}</span>
      </label>
      <span className="joint-value">
        <input type="number" aria-label={`${joint.name} value in ${joint.type === 'hinge' ? 'degrees' : 'millimetres'}`} min={low} max={high} step={step}
          value={typed ?? measure.format(Math.round(value * 1000) / 1000)}
          onChange={(event) => {
            setTyped(event.currentTarget.value);
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) onChange(clampJoint(joint, next), false);
          }}
          onBlur={() => setTyped(null)}/>
        <i>{unit}</i>
      </span>
      <input id={id} type="range" min={low} max={high} step="any" value={value} disabled={low === high}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber, true)}
        onPointerUp={() => onChange(value, false)} onKeyUp={() => onChange(value, false)} onBlur={() => onChange(value, false)}/>
      <span className="joint-limits"><span>{measure.format(low)}{unit}</span><span>{measure.format(high)}{unit}</span></span>
    </div>
  );
}

interface ViewportProps {
  model?: ModelPreview;
  pose: Pose;
  stale: boolean;
  running?: string;
  onPose(pose: Pose): void;
  onResetPose(): void;
}

export function Viewport({ model, pose, stale, running, onPose, onResetPose }: ViewportProps) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createViewer> | null>(null);
  const shown = useRef<ModelPreview | undefined>(undefined);
  const dragging = useRef(false);
  const [graphicsFailed, setGraphicsFailed] = useState(false);
  const [software, setSoftware] = useState(false);
  const [grid, setGrid] = useState(true);
  const [edges, setEdges] = useState(true);
  const [angle, setAngle] = useState<ViewAngle | null>('iso');
  const [jointsOpen, setJointsOpen] = useState(true);

  useEffect(() => {
    if (!canvasHost.current) return;
    try {
      controller.current = createViewer(canvasHost.current, () => setAngle(null), setGraphicsFailed);
      setSoftware(controller.current.software);
    } catch {
      setGraphicsFailed(true);
    }
    return () => {
      controller.current?.dispose();
      controller.current = null;
      shown.current = undefined;
    };
  }, []);

  // A new build replaces the meshes. A pose change only moves them.
  useEffect(() => {
    if (shown.current !== model) {
      shown.current = model;
      controller.current?.setModel(model, pose);
    } else {
      controller.current?.setPose(pose, dragging.current);
    }
  }, [model, pose]);
  useEffect(() => controller.current?.showGrid(grid), [grid]);
  useEffect(() => controller.current?.showEdges(edges), [edges]);

  const size = useMemo(() => {
    if (!model) return undefined;
    const { min, max } = poseBounds(model.assembly, model.partMesh.map((i) => model.meshes[i].bounds), pose);
    return max.map((value, i) => value - min[i]);
  }, [model, pose]);
  const joints = model?.assembly.joints.filter((joint) => joint.type !== 'fixed') ?? [];
  const partCount = model?.assembly.parts.length ?? 0;

  return (
    <section className="preview-pane" aria-label="Model preview">
      <div className="preview-toolbar">
        <div className="pane-title">
          {model?.isAssembly ? <Boxes size={17} /> : <Box size={17} />} <h2>3D Preview</h2>
          {model?.isAssembly && <span className="part-count">{partCount} {partCount === 1 ? 'part' : 'parts'}</span>}
        </div>
        <div className="preview-tools">
          <button className="view-tool" type="button" title="Toggle grid and axes" aria-pressed={grid} onClick={() => setGrid(!grid)}><Grid3X3 size={16}/><span>Grid</span></button>
          <button className="view-tool" type="button" title="Toggle part edges" aria-pressed={edges} onClick={() => setEdges(!edges)}><Layers2 size={16}/><span>Edges</span></button>
          <span className="view-tool-divider" />
          <button className="view-tool" type="button" title="Fit model to view" aria-label="Fit model to view" onClick={() => controller.current?.fit()}><Expand size={16}/></button>
        </div>
      </div>
      <div className="preview-stage">
        <div className="canvas-host" ref={canvasHost} />
        <div className="view-angles" aria-label="View angle">
          {angles.map((item) => (
            <button key={item.angle} type="button" title={`${item.name} view`} aria-pressed={angle === item.angle} onClick={() => {
              setAngle(item.angle);
              controller.current?.fit(item.angle);
            }}>{item.label}</button>
          ))}
        </div>
        {joints.length > 0 && !graphicsFailed && (
          <section className="joints" aria-label="Joints">
            <header>
              <button type="button" className="joints-toggle" aria-expanded={jointsOpen} onClick={() => setJointsOpen(!jointsOpen)}>
                Joints <span>{joints.length}</span>
              </button>
              {jointsOpen && <button type="button" className="joints-reset" title="Return every joint to the value in the code" onClick={onResetPose}><RotateCcw size={12}/> Reset</button>}
            </header>
            {jointsOpen && (
              <div className="joint-list">
                {joints.map((joint) => (
                  <JointControl key={joint.name} joint={joint} value={clampJoint(joint, pose[joint.name])} onChange={(value, isDragging) => {
                    dragging.current = isDragging;
                    onPose({ ...pose, [joint.name]: value });
                  }}/>
                ))}
              </div>
            )}
          </section>
        )}
        {graphicsFailed ? (
          <div className="preview-overlay"><TriangleAlert size={24}/><strong>Graphics context unavailable</strong><span>Reload the page to reopen the preview.</span></div>
        ) : !model && (
          <div className="preview-overlay">{running ? <LoaderCircle className="spin" size={25}/> : <Box size={29}/>}<strong>{running ?? 'Build a model to preview it'}</strong></div>
        )}
        {model && stale && !graphicsFailed && <div className="stale-preview"><span /> Previous build</div>}
      </div>
      <footer className="preview-footer">
        <div className="measurements" aria-label="Model bounding dimensions">
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <span className="measurement" key={axis}><b>{axis}</b><span>{size ? measure.format(Math.round(size[i] * 1e4) / 1e4) : '—'}</span></span>
          ))}
          <span className="unit">mm</span>
        </div>
        <div className="preview-help" title={software ? 'Software preview uses the CPU for drawing.' : undefined}><Mouse size={13} /> <span>Drag to orbit · Scroll to zoom</span></div>
      </footer>
    </section>
  );
}

import { Box, Boxes, Check, Copy, CornerDownRight, Expand, Eye, EyeOff, Grid3X3, Layers2, Link2, LoaderCircle, Mouse, MoveHorizontal, Pause, Play, Ruler, RotateCcw, RotateCw, ScanSearch, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clampJoint, followerStates, movingJoints, poseBounds, solvePose, structureOf, turnsFully, type JointSpec } from '../engine/assembly.ts';
import { advanceJoint, loopStates, moveJoint } from '../engine/kinematics.ts';
import type { CollisionAnswer, CollisionTest, MeasurePick, MeasureResult, ModelPreview, Pose, Reading } from '../engine/protocol.ts';
import { partQualities } from '../engine/summary.ts';
import { CollisionChecker, clearMove, overlapFloor, sweepJoint, type PairHit, type SweepResult } from '../collision.ts';
import type { Hit } from '../picking.ts';
import { createViewer, type Mark, type ViewAngle } from './viewer.ts';

const angles: { angle: ViewAngle; label: string; name: string }[] = [
  { angle: 'iso', label: 'ISO', name: 'Isometric' },
  { angle: 'top', label: 'TOP', name: 'Top' },
  { angle: 'front', label: 'FRONT', name: 'Front' },
  { angle: 'right', label: 'RIGHT', name: 'Right' },
];
const measure = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4, useGrouping: false });
// Readings of the Measure tool: 0.001 mm (and mm²), 0.01 degree.
const lengthFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3, useGrouping: false });
const angleFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false });
const readingText = (reading: Reading) => (reading.unit === '°' ? angleFormat : lengthFormat).format(Math.abs(reading.value) < 5e-4 && reading.unit !== '°' ? 0 : reading.value);

interface JointControlProps {
  joint: JointSpec;
  value: number;
  /** True when the joint is part of a closed loop, so other joints follow it. */
  linked: boolean;
  playing: boolean;
  /** Playing is off while a measurement is shown, because its values belong to one pose. */
  locked: boolean;
  /** True while a motion check of this joint runs. */
  checking: boolean;
  /** False when there is no second part to run into, or another check is running. */
  canCheck: boolean;
  onChange(value: number, dragging: boolean): void;
  onPlay(): void;
  onCheck(): void;
}

function JointControl({ joint, value, linked, playing, locked, checking, canCheck, onChange, onPlay, onCheck }: JointControlProps) {
  const [low, high] = joint.limits;
  const unit = joint.type === 'hinge' ? '°' : 'mm';
  const step = high - low > 20 ? 1 : 0.1;
  const id = `joint-${joint.name}`;
  // The number box keeps what is typed until it is a value the joint can take.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <div className="joint">
      <label htmlFor={id} title={`${joint.parent} → ${joint.child}${linked ? ' · in a loop: the joints around the loop move together' : ''}`}>
        {joint.type === 'hinge' ? <RotateCw size={13}/> : <MoveHorizontal size={13}/>}<span>{joint.name}</span>
        {linked && <Link2 className="joint-linked" size={12} aria-label="in a loop"/>}
      </label>
      <span className="joint-value">
        <button type="button" className="joint-check" aria-pressed={checking} title={checking ? `Stop checking ${joint.name}` : `Check motion: turn ${joint.name} through its travel and list where parts overlap`}
          aria-label={checking ? `Stop checking ${joint.name}` : `Check motion of ${joint.name}`} disabled={joint.limits[0] === joint.limits[1] || (!canCheck && !checking)} onClick={onCheck}>
          {checking ? <X size={11}/> : <ScanSearch size={11}/>}
        </button>
        <button type="button" className="joint-play" aria-pressed={playing} title={locked ? 'Clear the measurement to play a joint' : playing ? `Stop ${joint.name}` : `Run ${joint.name} through its travel`} aria-label={playing ? `Stop ${joint.name}` : `Play ${joint.name}`} disabled={joint.limits[0] === joint.limits[1] || locked} onClick={onPlay}>
          {playing ? <Pause size={11}/> : <Play size={11}/>}
        </button>
        <input type="number" aria-label={`${joint.name} value in ${joint.type === 'hinge' ? 'degrees' : 'millimetres'}`} min={low} max={high} step={step}
          value={typed ?? measure.format(Math.round(value * 100) / 100)}
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
        onPointerUp={() => onChange(value, false)} onPointerCancel={() => onChange(value, false)} onKeyUp={() => onChange(value, false)} onBlur={() => onChange(value, false)}/>
      <span className="joint-limits"><span>{measure.format(low)}{unit}</span><span>{measure.format(high)}{unit}</span></span>
    </div>
  );
}

function ReadingRow({ reading }: { reading: Reading }) {
  const [copied, setCopied] = useState(false);
  const text = readingText(reading);
  return (
    <div className="reading">
      <dt>{reading.label}</dt>
      <dd>
        <span>{text}</span><i>{reading.unit}</i>
        <button type="button" title={`Copy ${text}`} aria-label={`Copy ${reading.label} ${text}`} onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }, () => {});
        }}>{copied ? <Check size={12}/> : <Copy size={12}/>}</button>
      </dd>
    </div>
  );
}

/** One place in a joint's travel where two parts overlap. volume is null when only the preview mesh could say so. */
interface Finding {
  a: number;
  b: number;
  from: number;
  to: number;
  openFrom: boolean;
  openTo: boolean;
  /** The largest exact overlap among the poses that were checked, or null when only the preview mesh could say so. */
  volume: number | null;
  /** How many poses of the stretch were checked exactly. */
  poses: number;
}

interface MotionReport {
  joint: string;
  unit: string;
  samples: number;
  /** The other joints, as they were when the check ran. */
  pose: Pose;
  findings: Finding[];
  /** Stretches where the exact solids say the parts only touch. They are left out of the list. */
  touching: number;
  /** Stretches the exact solids were not asked about, because time ran out. */
  unconfirmed: number;
  stoppedAt?: number;
  cancelled: boolean;
}

interface MotionState {
  joint: string;
  /** What is being done and how far it is, 0 to 1. */
  phase: 'sweep' | 'exact';
  done: number;
  report?: MotionReport;
}

function MotionResults({ report, model, pose, onGo }: { report: MotionReport; model: ModelPreview; pose: Pose; onGo(finding: Finding): void }) {
  const place = (value: number) => `${measure.format(Math.round(value * 100) / 100)}${report.unit === 'mm' ? ' mm' : report.unit}`;
  const movedOn = Object.keys({ ...pose, ...report.pose }).some((name) => name !== report.joint && Math.abs((pose[name] ?? 0) - (report.pose[name] ?? 0)) > 1e-9);
  const name = (part: number) => model.assembly.parts[part].name;
  return (
    <div className="collision-motion">
      {report.findings.length === 0 && !report.unconfirmed && <p className="measure-hint">No overlap in {report.samples} poses of {report.joint}.</p>}
      {report.findings.map((finding, i) => (
        <button type="button" className="collision-finding" key={i} title={`Set ${report.joint} to ${place(finding.from)}, where the overlap starts`} onClick={() => onGo(finding)}>
          <span>{name(finding.a)} and {name(finding.b)} overlap {finding.openFrom ? 'from the start of the travel' : `from ${place(finding.from)}`} to {finding.openTo ? 'the end of the travel' : place(finding.to)} of {report.joint}</span>
          <i>{finding.volume === null ? 'found on the preview mesh only' : `${volumeText(finding.volume)} mm³ in the worst of ${finding.poses} ${finding.poses === 1 ? 'pose' : 'poses'} checked`}</i>
        </button>
      ))}
      {report.touching > 0 && <p className="collision-note">{report.touching} {report.touching === 1 ? 'place where' : 'places where'} parts only touch {report.touching === 1 ? 'is' : 'are'} not listed.</p>}
      {report.unconfirmed > 0 && <p className="collision-note">{report.unconfirmed} {report.unconfirmed === 1 ? 'stretch was' : 'stretches were'} not measured exactly because time ran out. {report.unconfirmed === 1 ? 'It is' : 'They are'} listed from the preview mesh and may only touch.</p>}
      {report.stoppedAt !== undefined && <p className="collision-note">The loop could not follow {report.joint} past {place(report.stoppedAt)}, so the travel after it was not checked.</p>}
      {movedOn && <p className="collision-note">Another joint has moved since this check. Check again to include it.</p>}
    </div>
  );
}

const volumeFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: false });
const volumeText = (value: number) => (value < 0.01 ? '<0.01' : volumeFormat.format(value));
/** The time the exact solids may take, in all, to confirm one motion check. */
const confirmBudgetMs = 45_000;
/** Above this many triangles in all, the page does not check for collisions at every pose. */
const maxLiveTriangles = 600_000;
const pairNames = (model: ModelPreview, pairs: [number, number][]) => pairs
  .map(([a, b]) => `${model.assembly.parts[a].name} and ${model.assembly.parts[b].name}`).join(', ');

interface ViewportProps {
  model?: ModelPreview;
  pose: Pose;
  stale: boolean;
  running?: string;
  onPose(pose: Pose): void;
  onResetPose(): void;
  /** Read one or two picks of the model on screen, in a pose. Rejects with a message the engineer can act on. */
  onMeasure(picks: MeasurePick[], pose: Pose): Promise<MeasureResult>;
  /** The exact overlap volume of pairs of parts in poses. Rejects while the engine is busy. */
  onCollide(tests: CollisionTest[]): Promise<CollisionAnswer>;
}

export function Viewport({ model, pose, stale, running, onPose, onResetPose, onMeasure, onCollide }: ViewportProps) {
  const canvasHost = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createViewer> | null>(null);
  const shown = useRef<ModelPreview | undefined>(undefined);
  const dragging = useRef(false);
  const [graphicsFailed, setGraphicsFailed] = useState(false);
  const [software, setSoftware] = useState(false);
  const [grid, setGrid] = useState(true);
  const [edges, setEdges] = useState(true);
  const [angle, setAngle] = useState<ViewAngle | null>('iso');
  // On a narrow screen the panel starts as one row, so it does not cover the model.
  const [jointsOpen, setJointsOpen] = useState(() => !window.matchMedia('(max-width: 710px)').matches);
  const [playing, setPlaying] = useState<string | null>(null);
  // Parts left out of the preview, by name. The STEP export still holds every part.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const partsMenu = useRef<HTMLDetailsElement>(null);
  // The Measure tool: what is picked (at most two), what the engine read from them, and why it could not.
  const [measuring, setMeasuring] = useState(false);
  const [picks, setPicks] = useState<Mark[]>([]);
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const reading = useRef({ busy: false, wanted: null as { picks: MeasurePick[]; pose: Pose } | null, latest: null as object | null });
  // Collisions. The quick check runs on the preview meshes in the page; the exact one runs in the worker once a pose has settled.
  const [stopAtCollision, setStopAtCollision] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const [motion, setMotion] = useState<MotionState | null>(null);
  const motionToken = useRef(0);
  const [verdicts, setVerdicts] = useState<{ pose: Pose; volumes: Map<number, number | null> } | null>(null);
  const checker = useMemo(() => (model ? new CollisionChecker(model.assembly, model.partMesh.map((i) => model.meshes[i])) : null), [model]);
  const live = useRef({ model, pose, onPose, onMeasure, picks, measuring, checker, stopAtCollision });
  live.current = { model, pose, onPose, onMeasure, picks, measuring, checker, stopAtCollision };

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
  // Play: run one joint through its travel. A hinge without end stops keeps turning.
  // Any other joint goes back and forth, and so does one that meets a dead point.
  useEffect(() => {
    if (!playing) return;
    let direction = 1;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const { model: current, pose: at, onPose: send } = live.current;
      const joint = current?.assembly.joints.find((item) => item.name === playing);
      if (!current || !joint) {
        setPlaying(null);
        return;
      }
      const seconds = Math.min(0.05, (now - last) / 1000);
      last = now;
      const speed = joint.type === 'hinge' ? 110 : (joint.limits[1] - joint.limits[0]) / 2.5;
      let moved = advanceJoint(current.assembly, at, joint.name, direction * speed * seconds);
      const value = moved.pose[joint.name];
      if (live.current.stopAtCollision && live.current.checker) {
        const clear = clearMove(live.current.checker, at, joint.name, value);
        if (clear.blocked) {
          setStopNote(`${joint.name} stopped: ${pairNames(current, clear.by)}`);
          dragging.current = false;
          setPlaying(null);
          send(clear.pose);
          return;
        }
        moved = { pose: clear.pose, reached: moved.reached };
      }
      const atStop = !turnsFully(joint) && (value >= joint.limits[1] - 1e-9 || value <= joint.limits[0] + 1e-9);
      if (!moved.reached || atStop) direction = atStop ? (value <= joint.limits[0] + 1e-9 ? 1 : -1) : -direction;
      dragging.current = true;
      send(moved.pose);
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      dragging.current = false;
      // Redraw at full quality once the motion stops.
      controller.current?.setPose(live.current.pose, false);
    };
  }, [playing]);
  useEffect(() => setPlaying(null), [model]);
  useEffect(() => controller.current?.showGrid(grid), [grid]);
  useEffect(() => controller.current?.showEdges(edges), [edges]);
  useEffect(() => controller.current?.setHidden(hidden), [hidden]);
  // A rebuild keeps a part hidden while it still has that name. A part that is gone or renamed is forgotten.
  useEffect(() => {
    const names = new Set(model?.assembly.parts.map((part) => part.name));
    setHidden((current) => {
      const kept = [...current].filter((name) => names.has(name));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [model]);
  // Collisions: the quick check on the preview meshes, at every pose. Parts that are hidden are still checked.
  const tooBig = !!model && model.partMesh.reduce((sum, i) => sum + model.meshes[i].indices.length / 3, 0) > maxLiveTriangles;
  const hits = useMemo<PairHit[]>(() => {
    if (!model || !checker || tooBig || model.assembly.parts.length < 2) return [];
    try {
      return checker.check(solvePose(model.assembly, pose), true);
    } catch {
      return [];
    }
  }, [model, checker, pose, tooBig]);
  const pairCount = model?.assembly.parts.length ?? 0;
  const confirmed = verdicts?.pose === pose ? verdicts.volumes : undefined;
  // What the exact solids said overrides the mesh: a pair that only touches is not a collision.
  const overlaps = useMemo(() => hits.filter((hit) => {
    const volume = confirmed?.get(hit.a * pairCount + hit.b);
    return volume === undefined || volume === null || volume >= overlapFloor;
  }), [hits, confirmed, pairCount]);
  useEffect(() => {
    if (!model || !hits.length) return;
    const exact = (part: number) => model.meshes[model.partMesh[part]].quality === 'exact';
    const volumes = new Map<number, number | null>(hits.filter((hit) => !exact(hit.a) || !exact(hit.b)).map((hit) => [hit.a * pairCount + hit.b, null]));
    const pairs = hits.filter((hit) => exact(hit.a) && exact(hit.b)).map((hit): [number, number] => [hit.a, hit.b]);
    if (!pairs.length) {
      setVerdicts({ pose, volumes });
      return;
    }
    let cancelled = false;
    // Wait until the pose has stopped changing: the exact answer takes tens of milliseconds a pair.
    const timer = window.setTimeout(() => {
      onCollide([{ pose, pairs }]).then((answer) => {
        if (cancelled) return;
        pairs.forEach(([a, b], i) => volumes.set(a * pairCount + b, answer.volumes[0][i]));
        setVerdicts({ pose, volumes });
      }, () => { /* The engine is busy or has no build: the preview mesh's answer stays. */ });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hits, pose, model, pairCount]);
  useEffect(() => {
    const lines = overlaps.some((hit) => hit.segments.length) ? Float32Array.from(overlaps.flatMap((hit) => [...hit.segments])) : undefined;
    controller.current?.setCollisions(new Set(overlaps.flatMap((hit) => [hit.a, hit.b])), lines);
  }, [overlaps, model]);
  // A new build forgets what the last one said.
  useEffect(() => {
    motionToken.current++;
    setMotion(null);
    setVerdicts(null);
    setStopNote(null);
  }, [model]);

  /** Move a joint to a value, or as far toward it as it goes without running into a part it did not already touch. */
  function stepJoint(name: string, value: number) {
    if (!model) return pose;
    if (stopAtCollision && checker) {
      const clear = clearMove(checker, pose, name, value);
      setStopNote(clear.blocked ? `${name} stopped: ${pairNames(model, clear.by)}` : null);
      return clear.pose;
    }
    return moveJoint(model.assembly, pose, name, value).pose;
  }

  /** Turn one joint through its travel and list where parts overlap, then ask the exact solids about each stretch. */
  async function checkMotion(name: string) {
    if (!model || !checker) return;
    const token = ++motionToken.current;
    const stopped = () => token !== motionToken.current;
    setPlaying(null);
    setStopNote(null);
    const start = pose;
    setMotion({ joint: name, phase: 'sweep', done: 0 });
    let result: SweepResult;
    try {
      result = await sweepJoint(checker, start, name, {
        progress: async (done) => {
          setMotion({ joint: name, phase: 'sweep', done });
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        cancelled: stopped,
      });
    } catch {
      if (!stopped()) setMotion(null);
      return;
    }
    if (stopped()) return;
    const unit = result.unit;
    // Exact volumes, a few poses of each stretch at a time, for the stretches where both parts are exact.
    const exact = (part: number) => model.meshes[model.partMesh[part]].quality === 'exact';
    const rows = result.intervals.map((interval) => ({ interval, volumes: [] as (number | null)[], asked: exact(interval.a) && exact(interval.b) }));
    setMotion({ joint: name, phase: 'exact', done: 0 });
    const began = performance.now();
    const jobs = rows.flatMap((row, r) => (row.asked ? row.interval.probes.map((probe) => ({ r, probe })) : []));
    const chunk = 12;
    for (let k = 0; k < jobs.length && !stopped(); k += chunk) {
      if (performance.now() - began > confirmBudgetMs) break;
      const part = jobs.slice(k, k + chunk);
      try {
        const answer = await onCollide(part.map(({ r, probe }) => ({ pose: probe.pose, pairs: [[rows[r].interval.a, rows[r].interval.b]] })));
        part.forEach(({ r }, i) => rows[r].volumes.push(answer.volumes[i]?.[0] ?? null));
      } catch {
        break;
      }
      setMotion({ joint: name, phase: 'exact', done: Math.min(1, (k + chunk) / jobs.length) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (stopped()) return;
    const findings: Finding[] = [];
    let touching = 0;
    let unconfirmed = 0;
    for (const { interval, volumes, asked } of rows) {
      const complete = asked && volumes.length === interval.probes.length && volumes.every((volume) => volume !== null);
      const worst = complete ? Math.max(...(volumes as number[])) : null;
      if (asked && !complete) unconfirmed++;
      if (worst !== null && worst < overlapFloor) {
        touching++;
        continue;
      }
      findings.push({ a: interval.a, b: interval.b, from: interval.from, to: interval.to, openFrom: interval.openFrom, openTo: interval.openTo, volume: worst, poses: volumes.length });
    }
    setMotion({
      joint: name, phase: 'exact', done: 1,
      report: { joint: name, unit, samples: result.samples, pose: start, findings, touching, unconfirmed, stoppedAt: result.stoppedAt, cancelled: false },
    });
  }

  // Measure: the picks are kept in the page, the numbers come from the engine in the pose that is shown.
  useEffect(() => {
    controller.current?.setMeasure(measuring ? {
      onPick(hit: Hit | undefined) {
        if (!hit) {
          setPicks([]);
          return;
        }
        const mark: Mark = { part: hit.part, type: hit.type, index: hit.index };
        setPicks((current) => {
          if (current.length >= 2) return [mark];
          return current.some((item) => item.part === mark.part && item.type === mark.type && item.index === mark.index) ? current : [...current, mark];
        });
      },
    } : undefined);
  }, [measuring]);
  useEffect(() => controller.current?.setPicks(picks, result?.line), [picks, result]);
  useEffect(() => {
    // Indices belong to one build.
    setPicks([]);
    setResult(null);
    setMeasureError(null);
    reading.current.latest = null;
  }, [model]);
  useEffect(() => {
    const state = reading.current;
    if (!live.current.model || !picks.length) {
      state.latest = null;
      state.wanted = null;
      setResult(null);
      setMeasureError(null);
      return;
    }
    setPlaying(null);
    const job = { picks: picks.map(({ part, type, index }): MeasurePick => ({ part, type, index })), pose };
    state.latest = job;
    state.wanted = job;
    // One reading at a time. A joint slider asks for many, and only the latest one is answered.
    const pump = () => {
      const next = state.wanted;
      if (state.busy || !next) return;
      state.wanted = null;
      state.busy = true;
      live.current.onMeasure(next.picks, next.pose).then((answer) => {
        if (state.latest === next) {
          setResult(answer);
          setMeasureError(null);
        }
      }, (error: unknown) => {
        if (state.latest === next) {
          setResult(null);
          setMeasureError(error instanceof Error ? error.message : 'The measurement failed. Pick again.');
        }
      }).finally(() => {
        state.busy = false;
        pump();
      });
    };
    pump();
  }, [picks, pose, model]);
  // Esc clears the picks, and a second Esc leaves the tool.
  useEffect(() => {
    if (!measuring) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (partsMenu.current?.open) return;
      // Esc belongs to a field while someone types in it. A joint slider or a tick box is not typing, so Esc still works there.
      if (event.target instanceof HTMLElement && event.target.closest('textarea, select, [contenteditable="true"], input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"])')) return;
      if (live.current.picks.length) setPicks([]);
      else setMeasuring(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [measuring]);
  // The tool needs a build to read from.
  useEffect(() => {
    if (!model) setMeasuring(false);
  }, [model]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const menu = partsMenu.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);

  const size = useMemo(() => {
    if (!model) return undefined;
    const { min, max } = poseBounds(model.assembly, model.partMesh.map((i) => model.meshes[i].bounds), pose);
    return max.map((value, i) => value - min[i]);
  }, [model, pose]);
  const joints = model ? movingJoints(model.assembly) : [];
  const looped = model ? structureOf(model.assembly).looped : [];
  const loops = useMemo(() => (model ? loopStates(model.assembly, pose) : []), [model, pose]);
  const followers = useMemo(() => (model ? followerStates(model.assembly, pose) : []), [model, pose]);
  const partCount = model?.assembly.parts.length ?? 0;

  return (
    <section className="preview-pane" aria-label="Model preview">
      <div className="preview-toolbar">
        <div className="pane-title">
          {model?.isAssembly ? <Boxes size={17} /> : <Box size={17} />} <h2>3D Preview</h2>
          {model?.isAssembly && <span className="part-count" title={partQualities(model)}>{partCount} {partCount === 1 ? 'part' : 'parts'}</span>}
          {model && model.assembly.allowed.length > 0 && (
            <span className="part-count" title="allow_overlap() names these pairs, so they are not checked for collisions">{model.assembly.allowed.length} allowed</span>
          )}
          {model && !model.isAssembly && model.meshes[0]?.quality === 'faceted' && (
            <span className="part-count" title={`Faceted: uses ${model.meshes[0].reason}. STEP has flat faces.`}>faceted</span>
          )}
        </div>
        <div className="preview-tools">
          {model?.isAssembly && partCount > 1 && (
            <details ref={partsMenu} className="parts-menu" onKeyDown={(event) => {
              if (event.key === 'Escape' && partsMenu.current?.open) {
                partsMenu.current.open = false;
                partsMenu.current.querySelector('summary')?.focus();
              }
            }}>
              <summary className="view-tool" title="Show or hide parts in the preview" aria-label="Show or hide parts">
                {hidden.size ? <EyeOff size={16}/> : <Eye size={16}/>}<span>Parts</span>
                {hidden.size > 0 && <span className="parts-hidden">{hidden.size} hidden</span>}
              </summary>
              <div className="parts-popover">
                <header>
                  <strong>Parts</strong>
                  <button type="button" disabled={!hidden.size} onClick={() => setHidden(new Set())}>Show all</button>
                </header>
                <ul>
                  {model.assembly.parts.map((part) => (
                    <li key={part.name}>
                      <label>
                        <input type="checkbox" checked={!hidden.has(part.name)} onChange={(event) => {
                          const next = new Set(hidden);
                          if (event.currentTarget.checked) next.delete(part.name);
                          else next.add(part.name);
                          setHidden(next);
                        }}/>
                        <i aria-hidden="true" style={{ background: `rgb(${part.color.map((value) => Math.round(value * 255)).join(' ')})` }}/>
                        <span>{part.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p>Hiding changes the preview only. STEP still has every part.</p>
              </div>
            </details>
          )}
          <button className="view-tool" type="button" disabled={!model} aria-pressed={measuring} aria-label="Measure"
            title={measuring ? 'Leave Measure (Esc)' : 'Measure: click a face, an edge or a corner. Click two to read the distance and angle between them.'}
            onClick={() => setMeasuring(!measuring)}><Ruler size={16}/><span>Measure</span></button>
          <span className="view-tool-divider" />
          <button className="view-tool" type="button" title="Toggle grid and axes" aria-label="Grid and axes" aria-pressed={grid} onClick={() => setGrid(!grid)}><Grid3X3 size={16}/><span>Grid</span></button>
          <button className="view-tool" type="button" title="Toggle part edges" aria-label="Part edges" aria-pressed={edges} onClick={() => setEdges(!edges)}><Layers2 size={16}/><span>Edges</span></button>
          <span className="view-tool-divider" />
          <button className="view-tool" type="button" title="Fit model to view" aria-label="Fit model to view" onClick={() => controller.current?.fit()}><Expand size={16}/></button>
        </div>
      </div>
      <div className={`preview-stage${measuring ? ' measuring' : ''}`}>
        <div className="canvas-host" ref={canvasHost} />
        <div className="view-angles" aria-label="View angle">
          {angles.map((item) => (
            <button key={item.angle} type="button" title={`${item.name} view`} aria-pressed={angle === item.angle} onClick={() => {
              setAngle(item.angle);
              controller.current?.fit(item.angle);
            }}>{item.label}</button>
          ))}
        </div>
        {measuring && model && !graphicsFailed && (
          <section className="measure-card" aria-label="Measurement">
            <header>
              <Ruler size={14}/><strong>Measure</strong>
              <button type="button" className="measure-clear" disabled={!picks.length} onClick={() => setPicks([])}><X size={12}/> Clear</button>
            </header>
            {!picks.length && <p className="measure-hint">
              <span className="help-mouse">Click a face, an edge or a corner. Click a second one to read the distance and angle between them. Esc clears the picks, and a second Esc leaves Measure.</span>
              <span className="help-touch">Tap a face, an edge or a corner. Tap a second one to read the distance and angle between them. Tap empty space, or Clear, to start again. Tap Measure to leave it.</span>
            </p>}
            {picks.length === 1 && !result && !measureError && <p className="measure-hint">Reading…</p>}
            {result?.items.map((item, i) => (
              <div className="measure-item" key={i}>
                <h3><i className={i ? 'second' : 'first'} aria-hidden="true"/>{item.title}</h3>
                <dl>{item.readings.map((entry) => <ReadingRow key={entry.label} reading={entry}/>)}</dl>
              </div>
            ))}
            {result && result.between.length > 0 && (
              <div className="measure-item">
                <h3>Between the two</h3>
                <dl>{result.between.map((entry) => <ReadingRow key={entry.label} reading={entry}/>)}</dl>
              </div>
            )}
            {picks.length === 2 && result && result.between.length === 0 && <p className="measure-hint">Nothing to read between these two.</p>}
            {result?.notes.map((note) => <p className="measure-note" key={note}>{note}</p>)}
            {measureError && <p className="measure-error" role="alert">{measureError}</p>}
          </section>
        )}
        {model && !graphicsFailed && (overlaps.length > 0 || motion || stopNote || tooBig) && (
          <section className="collision-card" aria-label="Collisions">
            <header>
              <TriangleAlert size={14}/><strong>{overlaps.length ? 'Collision' : 'Collisions'}</strong>
              {motion && <button type="button" className="measure-clear" title="Close the motion check" onClick={() => {
                motionToken.current++;
                setMotion(null);
              }}><X size={12}/> Close</button>}
            </header>
            {tooBig && <p className="measure-hint">This model has too many triangles to check at every pose. Use Check motion on a joint.</p>}
            {overlaps.map((hit) => {
              const volume = confirmed?.get(hit.a * pairCount + hit.b);
              return (
                <p className="collision-row" key={`${hit.a}-${hit.b}`}>
                  <span>{pairNames(model, [[hit.a, hit.b]])}</span>
                  <i>{volume === undefined ? 'checking…' : volume === null ? 'found on the preview mesh only' : `${volumeText(volume)} mm³`}</i>
                </p>
              );
            })}
            {stopNote && <p className="collision-stop" role="status">{stopNote}</p>}
            {motion && !motion.report && (
              <p className="measure-hint" role="status">
                {motion.phase === 'sweep' ? `Turning ${motion.joint}` : 'Measuring the overlaps'}… {Math.round(motion.done * 100)}%
              </p>
            )}
            {motion?.report && <MotionResults report={motion.report} model={model} pose={pose} onGo={(finding) => onPose(moveJoint(model.assembly, pose, motion.joint, finding.from).pose)}/>}
          </section>
        )}
        {joints.length > 0 && !graphicsFailed && (
          <section className={`joints${jointsOpen ? ' open' : ''}`} aria-label="Joints">
            <header>
              <button type="button" className="joints-toggle" aria-expanded={jointsOpen} onClick={() => setJointsOpen(!jointsOpen)}>
                Joints <span>{joints.length}</span>
              </button>
              {jointsOpen && <button type="button" className="joints-reset" title="Return every joint to the value in the code" onClick={() => {
                setStopNote(null);
                onResetPose();
              }}><RotateCcw size={12}/> Reset</button>}
            </header>
            {jointsOpen && (
              <div className="joint-list">
                {joints.map((joint) => (
                  <JointControl key={joint.name} joint={joint} value={clampJoint(joint, pose[joint.name])}
                    linked={looped[model!.assembly.joints.indexOf(joint)]} playing={playing === joint.name} locked={picks.length > 0}
                    checking={motion?.joint === joint.name && !motion.report} canCheck={partCount > 1 && !(motion && !motion.report)}
                    onPlay={() => setPlaying(playing === joint.name ? null : joint.name)}
                    onCheck={() => {
                      if (motion && !motion.report) motionToken.current++, setMotion(null);
                      else void checkMotion(joint.name);
                    }}
                    onChange={(value, isDragging) => {
                      if (playing) setPlaying(null);
                      dragging.current = isDragging;
                      // In a loop the other joints follow, and the move stops where the loop would open.
                      onPose(isDragging || value !== clampJoint(joint, pose[joint.name]) ? stepJoint(joint.name, value) : { ...pose });
                    }}/>
                ))}
                {loops.map((loop) => (
                  <div key={loop.joint} className={`joint-loop${loop.closed ? '' : ' open'}`} title="A closing joint has no value of its own. The joints around its loop move to keep it shut.">
                    {loop.closed ? <Link2 size={12}/> : <TriangleAlert size={12}/>}
                    <span>{loop.joint}</span>
                    <i>{loop.closed ? 'closes loop' : `open by ${measure.format(Math.round(loop.gap * 100) / 100)} mm`}</i>
                  </div>
                ))}
                {followers.map(({ joint, driver, value }) => (
                  <div key={joint.name} className="joint-loop" title={`${joint.name} takes its value from ${driver.name}. Move ${driver.name} to move it.`}>
                    <CornerDownRight size={12}/>
                    <span>{joint.name}</span>
                    <i>follows {driver.name} · {measure.format(Math.round(value * 100) / 100)}{joint.type === 'hinge' ? '°' : ' mm'}</i>
                  </div>
                ))}
                {partCount > 1 && (
                  <label className="joint-stop" title="A joint you move or play stops at the last pose before it runs into a part it was clear of. This is a setting of the page and is not saved in the code.">
                    <input type="checkbox" checked={stopAtCollision} onChange={(event) => {
                      setStopAtCollision(event.currentTarget.checked);
                      setStopNote(null);
                    }}/> Stop at collision
                  </label>
                )}
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
        <div className="preview-help" title={software ? 'Software preview uses the CPU for drawing.' : undefined}><Mouse size={13} /> <span className="help-mouse">Drag to orbit · Scroll to zoom</span><span className="help-touch">Drag to orbit · Pinch to zoom</span></div>
      </footer>
    </section>
  );
}

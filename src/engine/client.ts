import { CadError, JOB_TIMEOUT_MS, type BuildStage, type CollisionTest, type GeometryCommand, type GeometryReply, type MeasurePick, type Pose, type ProjectAssets, type ProjectFiles } from './protocol.ts';

type JobResult = Extract<GeometryReply, { kind: 'preview' | 'step' | 'measure' | 'collide' }>;
type JobCommand =
  | { kind: 'build'; revision: number; files: ProjectFiles; entry: string; assetNames: string[]; newAssets: ProjectAssets }
  | { kind: 'export'; revision: number; pose: Pose }
  | { kind: 'measure'; revision: number; pose: Pose; picks: MeasurePick[] }
  | { kind: 'collide'; revision: number; tests: CollisionTest[] };

interface PendingJob {
  id: number;
  timer: number;
  progress(stage: BuildStage): void;
  resolve(reply: JobResult): void;
  reject(error: CadError): void;
}

export class BrowserGeometryEngine {
  #worker?: Worker;
  #pending?: PendingJob;
  #nextId = 0;
  /** The assets the current worker holds. A worker keeps what it is sent, so a build sends only what it lacks. */
  #held = new Map<string, Uint8Array>();

  async build(files: ProjectFiles, assets: ProjectAssets, entry: string, revision: number, progress: PendingJob['progress']) {
    const newAssets: ProjectAssets = {};
    for (const [name, bytes] of Object.entries(assets)) if (this.#held.get(name) !== bytes) newAssets[name] = bytes;
    const reply = await this.#send({ kind: 'build', files, entry, revision, assetNames: Object.keys(assets), newAssets }, progress,
      () => { this.#held = new Map(Object.entries(assets)); });
    if (reply.kind !== 'preview') throw new CadError('The geometry engine returned an unexpected result.');
    return reply.model;
  }

  async exportStep(revision: number, pose: Pose, progress: PendingJob['progress']) {
    const reply = await this.#send({ kind: 'export', revision, pose }, progress);
    if (reply.kind !== 'step') throw new CadError('The geometry engine returned an unexpected result.');
    return reply.bytes;
  }

  async measure(revision: number, pose: Pose, picks: MeasurePick[]) {
    const reply = await this.#send({ kind: 'measure', revision, pose, picks }, () => {});
    if (reply.kind !== 'measure') throw new CadError('The geometry engine returned an unexpected result.');
    return reply.result;
  }

  /** The exact overlap volume of pairs of parts in poses. The worker keeps the last build, so a stale preview can still be checked. */
  async collide(revision: number, tests: CollisionTest[]) {
    const reply = await this.#send({ kind: 'collide', revision, tests }, () => {});
    if (reply.kind !== 'collide') throw new CadError('The geometry engine returned an unexpected result.');
    return reply.answer;
  }

  cancel(reason = 'Cancelled. Run the current code to build the model again.') {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#held.clear();
    this.#finish()?.reject(new CadError(reason));
  }

  #finish() {
    const current = this.#pending;
    this.#pending = undefined;
    if (current) window.clearTimeout(current.timer);
    return current;
  }

  #getWorker() {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<GeometryReply>) => {
      const pending = this.#pending;
      if (!pending || data.id !== pending.id || this.#worker !== worker) return;
      if (data.kind === 'progress') {
        pending.progress(data.stage);
        return;
      }
      this.#finish();
      if (data.kind === 'error') pending.reject(new CadError(data.diagnostic.message, data.diagnostic.line, data.diagnostic.file));
      else pending.resolve(data);
    };
    worker.onerror = () => this.cancel('The geometry worker stopped. Try running the model again.');
    worker.onmessageerror = () => this.cancel('The geometry worker could not return the model.');
    this.#worker = worker;
    return worker;
  }

  async #send(command: JobCommand, progress: PendingJob['progress'], sent?: () => void): Promise<JobResult> {
    if (this.#pending) throw new CadError('A geometry job is already running.');
    const worker = this.#getWorker();
    const request: GeometryCommand = { ...command, id: ++this.#nextId };
    return new Promise<JobResult>((resolve, reject) => {
      const timer = window.setTimeout(() => this.cancel('The job reached 60 seconds. Try a simpler part.'), JOB_TIMEOUT_MS);
      this.#pending = { id: request.id, timer, progress, resolve, reject };
      try {
        worker.postMessage(request);
        sent?.();
      } catch {
        this.cancel('Could not send the model to the geometry worker.');
      }
    });
  }
}

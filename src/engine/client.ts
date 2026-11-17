import { CadError, JOB_TIMEOUT_MS, type BuildStage, type GeometryCommand, type GeometryReply, type Pose, type ProjectFiles } from './protocol.ts';

type JobResult = Extract<GeometryReply, { kind: 'preview' | 'step' }>;
type JobCommand =
  | { kind: 'build'; revision: number; files: ProjectFiles; entry: string }
  | { kind: 'export'; revision: number; pose: Pose };

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

  async build(files: ProjectFiles, entry: string, revision: number, progress: PendingJob['progress']) {
    const reply = await this.#send({ kind: 'build', files, entry, revision }, progress);
    if (reply.kind !== 'preview') throw new CadError('The geometry engine returned an unexpected result.');
    return reply.model;
  }

  async exportStep(revision: number, pose: Pose, progress: PendingJob['progress']) {
    const reply = await this.#send({ kind: 'export', revision, pose }, progress);
    if (reply.kind !== 'step') throw new CadError('The geometry engine returned an unexpected result.');
    return reply.bytes;
  }

  cancel(reason = 'Cancelled. Run the current code to build the model again.') {
    this.#worker?.terminate();
    this.#worker = undefined;
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

  async #send(command: JobCommand, progress: PendingJob['progress']): Promise<JobResult> {
    if (this.#pending) throw new CadError('A geometry job is already running.');
    const worker = this.#getWorker();
    const request: GeometryCommand = { ...command, id: ++this.#nextId };
    return new Promise<JobResult>((resolve, reject) => {
      const timer = window.setTimeout(() => this.cancel('The job reached 60 seconds. Try a simpler part.'), JOB_TIMEOUT_MS);
      this.#pending = { id: request.id, timer, progress, resolve, reject };
      try {
        worker.postMessage(request);
      } catch {
        this.cancel('Could not send the model to the geometry worker.');
      }
    });
  }
}

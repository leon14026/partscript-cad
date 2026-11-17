import { OcctKernel, type OcctModuleFactory } from 'occt-wasm';
import occtEntry from 'occt-wasm/dist/occt-wasm.js?url';
import occtBinary from 'occt-wasm/dist/occt-wasm.wasm?url';
import { ModelBuilder, type BuiltModel } from './build.ts';
import type { OpenScadFactory } from './scad.ts';
import { CadError, type GeometryCommand, type GeometryReply } from './protocol.ts';

const scope = self as DedicatedWorkerGlobalScope;
let builderPromise: Promise<ModelBuilder> | undefined;
let model: { revision: number; built: BuiltModel } | undefined;

function post(reply: GeometryReply) {
  scope.postMessage(reply);
}

async function loadKernel() {
  const moduleUrl = new URL(occtEntry, scope.location.href).href;
  const wasm = new URL(occtBinary, scope.location.href).href;
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl) as { default: OcctModuleFactory };
  return OcctKernel.init({ createModule, wasm });
}

async function loadOpenScad() {
  // Workers are emitted in assets/. The engine is served separately and can be replaced.
  const base = new URL(import.meta.env.BASE_URL, scope.location.origin);
  const url = import.meta.env.DEV
    ? new URL('engines/openscad/openscad.js', base).href
    : new URL('../engines/openscad/openscad.js', scope.location.href).href;
  const module = await import(/* @vite-ignore */ url) as { default: OpenScadFactory };
  return module.default;
}

function loadBuilder() {
  builderPromise ??= Promise.all([loadKernel(), loadOpenScad()])
    .then(([kernel, createOpenScad]) => new ModelBuilder(kernel, createOpenScad))
    .catch((error: unknown) => {
      builderPromise = undefined;
      throw error;
    });
  return builderPromise;
}

scope.onmessage = async ({ data }: MessageEvent<GeometryCommand>) => {
  const { id, revision } = data;
  try {
    if (data.kind === 'export') {
      if (!model || model.revision !== revision || !builderPromise) {
        throw new CadError('Run the current code before exporting STEP.');
      }
      post({ kind: 'progress', id, stage: 'export' });
      const bytes = (await builderPromise).exportStep(model.built, data.pose);
      scope.postMessage({ kind: 'step', id, bytes } satisfies GeometryReply, [bytes.buffer]);
      return;
    }

    model = undefined;
    post({ kind: 'progress', id, stage: 'load' });
    const builder = await loadBuilder();
    const built = await builder.build(data.files, data.entry, (stage) => post({ kind: 'progress', id, stage }));
    model = { revision, built };
    // The meshes stay in the builder's cache, so they are copied to the page instead of transferred.
    post({ kind: 'preview', id, model: built.preview });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Geometry calculation failed.';
    const place = error instanceof CadError ? { line: error.line, file: error.file } : {};
    post({ kind: 'error', id, diagnostic: { message, ...place } });
  }
};

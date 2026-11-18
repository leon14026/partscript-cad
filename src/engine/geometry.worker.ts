import { OcctKernel, type OcctModuleFactory } from 'occt-wasm';
import occtEntry from 'occt-wasm/dist/occt-wasm.js?url';
import occtBinary from 'occt-wasm/dist/occt-wasm.wasm?url';
import { unzipSync } from 'fflate';
import { ModelBuilder, type BuiltModel } from './build.ts';
import { libraries, type LibraryFiles, type OpenScadFactory } from './scad.ts';
import { CadError, type GeometryCommand, type GeometryReply, type ProjectAssets } from './protocol.ts';

const scope = self as DedicatedWorkerGlobalScope;
let builderPromise: Promise<ModelBuilder> | undefined;
let model: { revision: number; built: BuiltModel } | undefined;
/** The project's imported files. The page sends each once, and a build names the ones it uses. */
const assets: ProjectAssets = {};

function post(reply: GeometryReply) {
  scope.postMessage(reply);
}

async function loadKernel() {
  const moduleUrl = new URL(occtEntry, scope.location.href).href;
  const wasm = new URL(occtBinary, scope.location.href).href;
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl) as { default: OcctModuleFactory };
  return OcctKernel.init({ createModule, wasm });
}

/** Where a file under public/ is served. Workers are emitted in assets/, so the built site goes up one folder. */
function assetUrl(path: string) {
  const base = new URL(import.meta.env.BASE_URL, scope.location.origin);
  return import.meta.env.DEV
    ? new URL(path, base).href
    : new URL(`../${path}`, scope.location.href).href;
}

async function loadOpenScad() {
  // The engine is served separately and can be replaced.
  const url = assetUrl('engines/openscad/openscad.js');
  const module = await import(/* @vite-ignore */ url) as { default: OpenScadFactory };
  // Every run starts a fresh instance. Download the engine once and hand it the same bytes each time.
  const response = await fetch(new URL('openscad.wasm', url));
  if (!response.ok) throw new CadError('The OpenSCAD engine could not be loaded. Reload the page and try again.');
  const wasmBinary = await response.arrayBuffer();
  const create = module.default;
  const factory: OpenScadFactory = (options) => create({ ...options, wasmBinary });
  return factory;
}

const libraryCache = new Map<string, Promise<LibraryFiles>>();

/** Download and unzip a library the first time a build includes it, then keep it for later builds. */
function loadLibrary(name: string) {
  let loaded = libraryCache.get(name);
  if (!loaded) {
    loaded = (async () => {
      if (!Object.hasOwn(libraries, name)) throw new CadError(`${name} is not a library of this version.`);
      const response = await fetch(assetUrl(libraries[name as keyof typeof libraries]));
      if (!response.ok) throw new CadError(`The ${name} library could not be loaded. Reload the page and try again.`);
      return unzipSync(new Uint8Array(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      libraryCache.delete(name);
      throw error;
    });
    libraryCache.set(name, loaded);
  }
  return loaded;
}

function loadBuilder() {
  builderPromise ??= Promise.all([loadKernel(), loadOpenScad()])
    .then(([kernel, createOpenScad]) => new ModelBuilder(kernel, createOpenScad, loadLibrary))
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

    if (data.kind === 'measure') {
      if (!model || model.revision !== revision || !builderPromise) {
        throw new CadError('Run the current code before measuring.');
      }
      post({ kind: 'measure', id, result: (await builderPromise).measure(model.built, data.pose, data.picks) });
      return;
    }

    model = undefined;
    for (const name of Object.keys(assets)) if (!data.assetNames.includes(name)) delete assets[name];
    Object.assign(assets, data.newAssets);
    const missing = data.assetNames.find((name) => !Object.hasOwn(assets, name));
    if (missing) throw new CadError(`${missing} did not reach the geometry engine. Run the model again.`, undefined, missing);
    post({ kind: 'progress', id, stage: 'load' });
    const builder = await loadBuilder();
    const built = await builder.build(data.files, data.entry, (stage) => post({ kind: 'progress', id, stage }), assets);
    model = { revision, built };
    // The meshes stay in the builder's cache, so they are copied to the page instead of transferred.
    post({ kind: 'preview', id, model: built.preview });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Geometry calculation failed.';
    const place = error instanceof CadError ? { line: error.line, file: error.file } : {};
    post({ kind: 'error', id, diagnostic: { message, ...place } });
  }
};

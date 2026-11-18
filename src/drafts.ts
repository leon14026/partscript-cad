import { isAsset, readProject, type Project } from './project.ts';

let connection: Promise<IDBDatabase> | undefined;

/**
 * The imported files the database holds, as the arrays they were saved from. A file is written again only when its
 * array is a different one, so editing a text file does not copy tens of megabytes on every autosave.
 */
let stored = new Map<string, Uint8Array>();

function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    // Version 2 added the store of imported files. A version 1 database holds drafts of text files only, which still load.
    const open = indexedDB.open('partscript-workspace', 2);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('drafts')) open.result.createObjectStore('drafts');
      if (!open.result.objectStoreNames.contains('assets')) open.result.createObjectStore('assets');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return connection;
}

function wait<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadDraft(): Promise<Project | undefined> {
  const db = await database();
  const draft = await wait(db.transaction('drafts', 'readonly').objectStore('drafts').get('current')) as Record<string, unknown> | undefined;
  if (!draft) return undefined;
  const list = Array.isArray(draft.files) ? draft.files as Record<string, unknown>[] : undefined;
  if (!list) return readProject(draft);

  // An imported file is saved as a stub that names it, with its bytes in the other store. Ask for all of them at once.
  const assets = db.transaction('assets', 'readonly').objectStore('assets');
  const bytes = list.map((item) => (item?.asset === true ? wait(assets.get(item.name as string)) : undefined));
  const files: unknown[] = [];
  const loaded = new Map<string, Uint8Array>();
  for (const [i, item] of list.entries()) {
    if (item?.asset !== true) {
      files.push(item);
      continue;
    }
    const data = await bytes[i] as Uint8Array | undefined;
    // A file whose bytes are gone is left out. The build then says the file is not in the project.
    if (data instanceof Uint8Array) {
      files.push({ name: item.name, data });
      loaded.set(item.name as string, data);
    }
  }
  const project = readProject({ ...draft, files });
  if (project) stored = loaded;
  return project;
}

export async function saveDraft(draft: Project): Promise<void> {
  const db = await database();
  const keep = new Map(draft.files.filter(isAsset).map((file) => [file.name, file.data]));
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['drafts', 'assets'], 'readwrite');
    const assets = transaction.objectStore('assets');
    for (const [name, data] of keep) if (stored.get(name) !== data) assets.put(data, name);
    for (const name of stored.keys()) if (!keep.has(name)) assets.delete(name);
    transaction.objectStore('drafts').put({
      files: draft.files.map((file) => (isAsset(file) ? { name: file.name, asset: true } : file)),
      active: draft.active,
      entry: draft.entry,
    }, 'current');
    transaction.oncomplete = () => {
      stored = keep;
      resolve();
    };
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

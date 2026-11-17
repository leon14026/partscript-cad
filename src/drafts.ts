import { readProject, type Project } from './project.ts';

let connection: Promise<IDBDatabase> | undefined;

function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('partscript-workspace', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('drafts');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return connection;
}

export async function loadDraft(): Promise<Project | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const read = db.transaction('drafts', 'readonly').objectStore('drafts').get('current');
    read.onsuccess = () => resolve(readProject(read.result));
    read.onerror = () => reject(read.error);
  });
}

export async function saveDraft(draft: Project): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    transaction.objectStore('drafts').put({ files: draft.files, active: draft.active, entry: draft.entry }, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

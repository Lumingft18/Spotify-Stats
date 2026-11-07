// Queue of exports from different people, imported one after the other.
// The ZIPs are kept in IndexedDB (this browser only) so the queue survives the reload between two analyses.
// Flow: import the first entry → enrichment runs on it → when it's done the page reloads and imports the next.
import { getApp } from './store';
import { leaveAnalysis } from './analyses';
import { hasAccountData } from '../data/import';

export interface QueueEntry {
  id: string;
  /** Typed name; empty when the "account data" ZIP provides it. */
  name: string;
  files: File[];
  added_at: number;
  error?: string;
}

/** What the UI shows (no File blobs in the store). */
export interface QueueItem {
  id: string;
  name: string;
  fileNames: string[];
  bytes: number;
  error?: string;
  /** Being imported right now. */
  importing?: boolean;
}

const DB = 'ascolti-import-queue';
const STORE = 'entries';
/** Set right before the reload that should import the next entry. */
const AUTO_KEY = 'ss2.queueAuto';
/** Id of the analysis created from the queue and still enriching (advance when it completes). */
const ACTIVE_KEY = 'ss2.queueActive';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('IndexedDB: transazione annullata'));
    });
  } finally {
    db.close();
  }
}

async function all(): Promise<QueueEntry[]> {
  const list = (await tx('readonly', (s) => s.getAll())) as QueueEntry[];
  return list.sort((a, b) => a.added_at - b.added_at);
}

const toItem = (e: QueueEntry): QueueItem => ({
  id: e.id,
  name: e.name,
  fileNames: e.files.map((f) => f.name),
  bytes: e.files.reduce((n, f) => n + f.size, 0),
  error: e.error,
  importing: e.id === importingId,
});

let importingId: string | null = null;

/** Re-reads the queue into the app store. */
export async function refreshQueue(): Promise<QueueItem[]> {
  const items = (await all().catch(() => [] as QueueEntry[])).map(toItem);
  getApp().set({ queue: items });
  return items;
}

export async function enqueue(name: string, files: File[]): Promise<QueueEntry> {
  const e: QueueEntry = { id: crypto.randomUUID(), name: name.trim(), files, added_at: Date.now() };
  await tx('readwrite', (s) => s.put(e));
  await refreshQueue();
  return e;
}

export async function dequeue(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  await refreshQueue();
}

async function markError(e: QueueEntry, msg: string) {
  await tx('readwrite', (s) => s.put({ ...e, error: msg }));
}

/** First entry that hasn't failed. */
async function firstReady(): Promise<QueueEntry | null> {
  return (await all().catch(() => [] as QueueEntry[])).find((e) => !e.error) ?? null;
}

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export const queueActiveId = () => lsGet(ACTIVE_KEY);
export const setQueueActive = (id: string | null) => lsSet(ACTIVE_KEY, id);

let processing = false;
export const isQueueProcessing = () => processing;

/**
 * Imports the first waiting entry into a new analysis (start screen only: nothing else loaded).
 * `run` is the import itself, injected by the caller to keep this module free of the data layer.
 * A failed entry stays in the queue with its error and the next one is tried.
 */
export async function processNext(run: (e: QueueEntry) => Promise<string | null>): Promise<boolean> {
  if (processing) return false;
  processing = true;
  try {
    for (;;) {
      const e = await firstReady();
      if (!e) return false;
      importingId = e.id;
      await refreshQueue();
      try {
        const analysisId = await run(e);
        await tx('readwrite', (s) => s.delete(e.id));
        setQueueActive(analysisId);
        await refreshQueue();
        return true;
      } catch (err) {
        await markError(e, err instanceof Error ? err.message : String(err));
        await refreshQueue();
        getApp().set({ status: 'empty' });
      } finally {
        importingId = null;
      }
    }
  } finally {
    processing = false;
  }
}

/** True once after the reload asked for by `advanceQueue`. */
export function takeAutoStart(): boolean {
  const on = lsGet(AUTO_KEY) === '1';
  lsSet(AUTO_KEY, null);
  return on;
}

/**
 * The open analysis is done (or the person asked to skip ahead): if someone is waiting,
 * go back to a clean start screen and import them. Enrichment of the current one resumes when it's reopened.
 */
export async function advanceQueue(): Promise<boolean> {
  setQueueActive(null);
  if (!(await firstReady())) {
    await refreshQueue();
    return false;
  }
  lsSet(AUTO_KEY, '1');
  leaveAnalysis();
  return true;
}

/** Keeps only Spotify export files; an error when nothing usable or a name is needed. */
export async function checkQueueFiles(list: FileList | File[] | null, name: string): Promise<{ files: File[] } | { error: string; files?: File[] }> {
  const files = Array.from(list ?? []).filter((f) => /\.(zip|json)$/i.test(f.name));
  if (!files.length) return { error: 'Seleziona il file .zip esportato da Spotify (oppure i file .json al suo interno).' };
  if (!name.trim() && !(await hasAccountData(files).catch(() => false)))
    return {
      files,
      error: 'Dai un nome a questa analisi (es. il nome della persona), poi premi “Continua”. Con lo ZIP “Dati dell’account” il nome lo prendo da lì.',
    };
  return { files };
}


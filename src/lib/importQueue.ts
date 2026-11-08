// Queue of exports from different people, imported one after the other.
// The ZIPs are kept in IndexedDB (this browser only) so the queue survives the reload between two analyses.
// Flow: import the first entry → enrichment runs on it → when it's done the page reloads and imports the next.
import { getApp } from './store';
import { analyses, currentAnalysisId, leaveAnalysis, openAnalysis, type Analysis } from './analyses';
import { persistMeta } from '../data/db';
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
  writeTries({}); // new work: give every analysis another chance in the chain
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
 * Automatic runs that ended without completing (a few lookups keep failing, a step errored), per analysis.
 * The chain keeps coming back to an analysis until it completes, up to MAX_TRIES runs that ended short.
 */
const TRIES_KEY = 'ss2.autoTries';
const MAX_TRIES = 3;
const readTries = (): Record<string, number> => {
  try {
    return JSON.parse(lsGet(TRIES_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
};
const writeTries = (t: Record<string, number>) => lsSet(TRIES_KEY, Object.keys(t).length ? JSON.stringify(t) : null);

/** Saved analyses that still need enriching, oldest first (the chain opens them one by one). */
export async function incompleteAnalyses(exclude: string | null = null): Promise<Analysis[]> {
  const tries = readTries();
  const list = await analyses.list().catch(() => [] as Analysis[]);
  return list
    .filter((a) => !a.enriched_at && (a.rows ?? 0) > 0 && a.id !== exclude && (tries[a.id] ?? 0) < MAX_TRIES)
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * The analysis the chain is working on, when it is still incomplete: leaving it for the start screen doesn't end
 * its turn, so a new ZIP added meanwhile waits in the queue instead of taking its place.
 */
export async function chainInProgress(): Promise<Analysis | null> {
  const id = queueActiveId();
  if (!id) return null;
  const a = await analyses.get(id).catch(() => null);
  if (!a || a.enriched_at || (readTries()[a.id] ?? 0) >= MAX_TRIES) {
    setQueueActive(null);
    return null;
  }
  return a;
}

/** Someone waiting in the import queue (not failed)? */
export const hasWaiting = async () => !!(await firstReady());

/** Is there anything for the chain to do (someone waiting, an analysis to resume or to complete)? */
export async function chainHasWork(): Promise<boolean> {
  return !!(await firstReady()) || !!(await chainInProgress()) || (await incompleteAnalyses()).length > 0;
}

/**
 * The open analysis is done (or its automatic run ended, or the person skipped ahead): move on by itself.
 * 1. someone waiting in the import queue → clean start screen, import them;
 * 2. otherwise another saved analysis still to enrich → open it (enrichment resumes there).
 * Leaving an analysis halfway is fine: it stays in the list and the chain comes back to it.
 */
export async function advanceQueue(opts: { incomplete?: boolean } = {}): Promise<boolean> {
  const cur = currentAnalysisId();
  if (cur) {
    const tries = readTries();
    if (opts.incomplete) tries[cur] = (tries[cur] ?? 0) + 1;
    else delete tries[cur];
    writeTries(tries);
  }
  await persistMeta().catch(() => undefined);
  if (await firstReady()) {
    setQueueActive(null);
    lsSet(AUTO_KEY, '1');
    leaveAnalysis();
    return true;
  }
  // Fewest failed runs first: an analysis that keeps ending short doesn't hold the others back.
  const tries = readTries();
  const next = (await incompleteAnalyses(cur)).sort((a, b) => (tries[a.id] ?? 0) - (tries[b.id] ?? 0))[0];
  if (next) {
    setQueueActive(next.id);
    openAnalysis(next.id, '#/');
    return true;
  }
  setQueueActive(null);
  await refreshQueue();
  return false;
}

/** Start screen: continue the chain (the analysis it was on first, then the queue, then the rest). */
export async function resumeChain(): Promise<boolean> {
  const active = await chainInProgress();
  if (active) {
    openAnalysis(active.id, '#/');
    return true;
  }
  return advanceQueue();
}

/** "Complete everything": forget earlier give-ups and start the chain from the start screen. */
export async function startChain(): Promise<boolean> {
  writeTries({});
  return resumeChain();
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


// Shared cache of PUBLIC catalog metadata (cover URL, audio features) keyed by Spotify track URI.
// Lives in its own IndexedDB database so it survives importing a different export
// (e.g. a friend's ZIP) and "Cancella dati personali": nothing here identifies a listener on its own.
import type { MetaRow } from '../data/schema';

const DB = 'spotify-stats-catalog';
const STORE = 'tracks';
const CACHED_KEYS = ['cover', 'valence', 'energy', 'danceability', 'tempo', 'acousticness', 'mood_source', 'mood_conf'] as const;

let dbP: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbP)
    dbP = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  return dbP;
}

type Entry = Partial<Record<(typeof CACHED_KEYS)[number], string | number | null>>;

/** Stores only catalog-level fields; ignores lyrics/tags/clusters (personal or derived). */
export async function cacheCatalog(rows: MetaRow[]): Promise<void> {
  const useful = rows.filter((r) => r.uri.startsWith('spotify:track:') && CACHED_KEYS.some((k) => k in r) && (r.mood_source ?? 'reccobeats') !== 'llm');
  if (!useful.length) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const st = tx.objectStore(STORE);
    for (const r of useful) {
      const get = st.get(r.uri);
      get.onsuccess = () => {
        const prev = (get.result as Entry | undefined) ?? {};
        const next: Entry = { ...prev };
        for (const k of CACHED_KEYS) if (k in r && r[k] != null) next[k] = r[k] as never;
        st.put(next, r.uri);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns cached catalog data for the given URIs (only those present). */
export async function readCatalog(uris: string[]): Promise<MetaRow[]> {
  if (!uris.length) return [];
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const st = tx.objectStore(STORE);
    const out: MetaRow[] = [];
    for (const uri of uris) {
      const g = st.get(uri);
      g.onsuccess = () => {
        if (g.result) out.push({ uri, ...(g.result as Entry) });
      };
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

export async function catalogSize(): Promise<number> {
  const db = await open();
  return new Promise((resolve) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(0);
  });
}

export async function clearCatalog(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
  });
}

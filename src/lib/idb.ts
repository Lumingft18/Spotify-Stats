// Minimal promise-based IndexedDB key/value store.
// Two object stores: "kv" (generic blobs/objects) and "meta" (per-track enrichment cache).

const DB_NAME = 'spotify-stats-v2';
const DB_VERSION = 1;
export type StoreName = 'kv' | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const idb = {
  get<T>(key: string, store: StoreName = 'kv'): Promise<T | undefined> {
    return tx<T>(store, 'readonly', (s) => s.get(key));
  },
  set(key: string, value: unknown, store: StoreName = 'kv'): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.put(value, key);
    });
  },
  del(key: string, store: StoreName = 'kv'): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.delete(key);
    });
  },
  setMany(entries: Array<[string, unknown]>, store: StoreName = 'kv'): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      for (const [k, v] of entries) s.put(v, k);
    });
  },
  getAll<T>(store: StoreName): Promise<Array<[string, T]>> {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(store, 'readonly');
          const s = t.objectStore(store);
          const out: Array<[string, T]> = [];
          const req = s.openCursor();
          req.onsuccess = () => {
            const c = req.result;
            if (c) {
              out.push([String(c.key), c.value as T]);
              c.continue();
            } else resolve(out);
          };
          req.onerror = () => reject(req.error);
        }),
    );
  },
  clear(store: StoreName): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.clear();
    });
  },
  async wipe(): Promise<void> {
    const db = await open();
    db.close();
    dbPromise = null;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  },
};

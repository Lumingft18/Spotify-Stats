// Read-only access to the IndexedDB databases used before the local SQLite database existed.
// Only used once, to move an existing session into the database (src/lib/migrate.ts). Never written.

export const LEGACY_DATA_DB = 'spotify-stats-v2';
export const LEGACY_CATALOG_DB = 'spotify-stats-catalog';

export async function legacyExists(name: string): Promise<boolean> {
  try {
    if (typeof indexedDB.databases !== 'function') return true;
    return (await indexedDB.databases()).some((d) => d.name === name);
  } catch {
    return false;
  }
}

/** Every [key, value] of one object store; empty if the database or store doesn't exist. */
export function readLegacyStore<T = unknown>(dbName: string, store: string): Promise<Array<[string, T]>> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName);
    } catch {
      return resolve([]);
    }
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) {
        db.close();
        return resolve([]);
      }
      const out: Array<[string, T]> = [];
      const cur = db.transaction(store, 'readonly').objectStore(store).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          out.push([String(c.key), c.value as T]);
          c.continue();
        } else {
          db.close();
          resolve(out);
        }
      };
      cur.onerror = () => {
        db.close();
        resolve(out);
      };
    };
  });
}

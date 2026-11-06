// One-time move of data saved by older versions (browser IndexedDB) into the local database.
// The old IndexedDB copies are left untouched (read-only here), so nothing can be lost by a failed run.
import type { AccountProfile } from '../data/account';
import type { MetaRow } from '../data/schema';
import { analyses, setCurrentAnalysis } from './analyses';
import { cacheCatalog } from './catalogCache';
import { kv } from './kv';
import { LEGACY_CATALOG_DB, LEGACY_DATA_DB, legacyExists, readLegacyStore } from './legacyIdb';

const DONE_KEY = 'ss2.migrated-to-db';

let running: Promise<string | null> | null = null;

/** Returns the id of the analysis created from the old session, if there was one. Safe to call repeatedly. */
export function migrateLegacy(): Promise<string | null> {
  return (running ??= migrate());
}

async function migrate(): Promise<string | null> {
  try {
    if (localStorage.getItem(DONE_KEY)) return null;
  } catch {
    return null;
  }

  // 1) Shared catalog cache (covers, audio features, lyrics, tags).
  if (await legacyExists(LEGACY_CATALOG_DB)) {
    const rows = await readLegacyStore<Omit<MetaRow, 'uri'>>(LEGACY_CATALOG_DB, 'tracks');
    if (rows.length) await cacheCatalog(rows.map(([uri, v]) => ({ uri, ...v })));
  }

  // 2) The session that was open: becomes a saved analysis with the same data.
  let created: string | null = null;
  if (await legacyExists(LEGACY_DATA_DB)) {
    const entries = await readLegacyStore(LEGACY_DATA_DB, 'kv');
    const map = new Map(entries);
    if (map.has('plays_ipc')) {
      const profile = map.get('profile') as AccountProfile | undefined;
      const name = profile?.displayName || profile?.username || 'Analisi importata dal browser';
      const a = await analyses.create(name);
      setCurrentAnalysis(a.id);
      created = a.id;
      // Big values one by one, the rest in batches.
      const small: Array<[string, unknown]> = [];
      for (const [k, v] of entries) {
        if (k === 'plays_ipc' || k === 'meta_rows' || k === 'emb_index') await kv.set(k, v);
        else small.push([k, v]);
      }
      for (let i = 0; i < small.length; i += 50) await kv.setMany(small.slice(i, i + 50));
      // Old meta rows also feed the shared catalog (public fields only).
      const meta = map.get('meta_rows') as MetaRow[] | undefined;
      if (meta?.length) await cacheCatalog(meta);
    }
  }

  try {
    localStorage.setItem(DONE_KEY, new Date().toISOString());
  } catch {
    /* ignore */
  }
  return created;
}

// Shared cache of PUBLIC catalog metadata (cover URL, audio features, lyrics, genres) keyed by Spotify track URI.
// Lives in the local database (server/store.ts → catalog), shared by every analysis and every person using this
// install: nothing here identifies a listener on its own, and nothing is fetched twice.
import type { MetaRow } from '../data/schema';
import { apiJson } from './api';

const CACHED_KEYS = ['cover', 'valence', 'energy', 'danceability', 'tempo', 'acousticness', 'mood_source', 'mood_conf', 'lyrics', 'tags'] as const;

/** Stores only catalog-level fields; skips AI estimates (never shared as if they were measurements). */
export async function cacheCatalog(rows: MetaRow[]): Promise<void> {
  const useful = rows
    .filter((r) => r.uri.startsWith('spotify:track:') && CACHED_KEYS.some((k) => k in r && r[k] != null) && !['llm', 'artist'].includes(String(r.mood_source ?? 'reccobeats')))
    .map((r) => {
      const o: MetaRow = { uri: r.uri };
      for (const k of CACHED_KEYS) if (k in r && r[k] != null) o[k] = r[k];
      return o;
    });
  for (let i = 0; i < useful.length; i += 2000) await apiJson('/catalog/put', 'POST', { rows: useful.slice(i, i + 2000) });
}

/** Returns cached catalog data for the given URIs (only those present). */
export async function readCatalog(uris: string[]): Promise<MetaRow[]> {
  const out: MetaRow[] = [];
  for (let i = 0; i < uris.length; i += 5000) out.push(...(await apiJson<MetaRow[]>('/catalog/get', 'POST', { uris: uris.slice(i, i + 5000) })));
  return out;
}

export interface CatalogStats {
  tracks: number;
  covers: number;
  lyrics: number;
  audio: number;
  tags: number;
  embeddings: number;
  ai: number;
  images: number;
  imageBytes: number;
}

export const catalogStats = () => apiJson<CatalogStats>('/catalog/stats');

export async function catalogSize(): Promise<number> {
  return (await catalogStats()).tracks;
}

export async function clearCatalog(): Promise<void> {
  await apiJson('/catalog', 'DELETE');
}

/** Lookups already done by anyone (found or definitively missing), per enrichment step. */
export async function readTried(step: string, uris: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < uris.length; i += 5000) out.push(...(await apiJson<string[]>('/catalog/tried/get', 'POST', { step, uris: uris.slice(i, i + 5000) })));
  return out;
}

export async function writeTried(step: string, uris: string[]): Promise<void> {
  if (uris.length) await apiJson('/catalog/tried/put', 'POST', { step, uris });
}

/** "Riprova falliti": forgets every shared lookup so missing items are fetched again. */
export async function clearTriedShared(): Promise<void> {
  await apiJson('/catalog/tried', 'DELETE');
}

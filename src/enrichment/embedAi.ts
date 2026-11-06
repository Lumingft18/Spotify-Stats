// Taste map (embeddings + UMAP + clusters) as a background job: started automatically after enrichment
// when an OpenRouter key is set (toggle in Impostazioni), or by hand from Mood & Galassia.
import { query } from '../data/db';
import { buildIndex, computeLayout, DEFAULT_EMBED_MODEL, loadIndex } from '../ml/embeddings';
import { getApp } from '../lib/store';
import { isEnrichmentHeld } from './pause';

export const EMBED_JOB = 'embeddings';
const LABEL = 'Mappa del gusto (embedding)';

let ctrl: AbortController | null = null;
let running: Promise<void> | null = null;

export const isEmbeddingRunning = () => ctrl !== null;

export function stopEmbeddings() {
  ctrl?.abort();
}

export function embeddingsAvailable(): boolean {
  const s = getApp().settings;
  return s.connections.llm && !!s.openrouterKey;
}

/** Builds (or rebuilds) the index on the top-`limit` tracks. Progress is published as a job. */
export function startEmbeddings(limit: number): Promise<void> {
  if (running) return running;
  if (!embeddingsAvailable()) return Promise.resolve();
  const app = getApp();
  const c = new AbortController();
  ctrl = c;
  const job = (status: 'running' | 'done' | 'paused' | 'error', done = 0, total = 0, detail?: string) =>
    app.setJob({ id: EMBED_JOB, label: LABEL, done, total, status, detail });
  running = (async () => {
    try {
      job('running', 0, 0, 'avvio');
      await buildIndex(DEFAULT_EMBED_MODEL, limit, (stage, done, total) => job('running', done, total, stage), c.signal);
      job('done');
    } catch (e) {
      if (c.signal.aborted) job('paused');
      else job('error', 0, 0, e instanceof Error ? e.message : String(e));
    } finally {
      ctrl = null;
      running = null;
      getApp().bump();
    }
  })();
  return running;
}

/** Index saved but its map coordinates missing (e.g. the page was closed or reloaded during the layout step). */
export async function layoutMissing(): Promise<boolean> {
  const idx = await loadIndex();
  if (!idx?.uris.length) return false;
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::INT AS n FROM meta WHERE x IS NOT NULL`);
  return n < idx.uris.length * 0.5;
}

/** Recomputes the map from the saved vectors: local only (UMAP + clusters in a worker), no API call. */
export function repairLayout(): Promise<void> {
  if (running) return running;
  const app = getApp();
  running = (async () => {
    try {
      const idx = await loadIndex();
      if (!idx) return;
      app.setJob({ id: EMBED_JOB, label: LABEL, done: 0, total: 1, status: 'running', detail: 'ricalcolo della mappa dai vettori salvati' });
      await computeLayout(idx, (stage, done, total) => app.setJob({ id: EMBED_JOB, label: LABEL, done, total, status: 'running', detail: stage }));
      app.setJob({ id: EMBED_JOB, label: LABEL, done: 1, total: 1, status: 'done' });
    } catch (e) {
      app.setJob({ id: EMBED_JOB, label: LABEL, done: 0, total: 0, status: 'error', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      running = null;
      getApp().bump();
    }
  })();
  return running;
}

/** True when there is no index yet, or it covers clearly fewer tracks than the configured size. */
export async function embeddingsStale(limit: number): Promise<boolean> {
  const idx = await loadIndex();
  if (!idx) return true;
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::INT AS n FROM tracks WHERE plays > 0`);
  return idx.uris.length < (limit > 0 ? Math.min(limit, n) : n) * 0.8;
}

/** Runs only when enabled in Impostazioni, a key is set and the map is missing or too small. */
export async function autoEmbeddings(): Promise<void> {
  if (!ctrl && !running && (await layoutMissing())) await repairLayout();
  const s = getApp().settings;
  if (!s.autoEmbeddings || !embeddingsAvailable() || ctrl || isEnrichmentHeld()) return;
  if (!(await embeddingsStale(s.autoEmbeddingsLimit))) return;
  await startEmbeddings(s.autoEmbeddingsLimit);
}

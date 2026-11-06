// Taste map (embeddings + UMAP + clusters) as a background job: started automatically after enrichment
// when an OpenRouter key is set (toggle in Impostazioni), or by hand from Mood & Galassia.
import { query } from '../data/db';
import { buildIndex, DEFAULT_EMBED_MODEL, loadIndex } from '../ml/embeddings';
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

/** True when there is no index yet, or it covers clearly fewer tracks than the configured size. */
export async function embeddingsStale(limit: number): Promise<boolean> {
  const idx = await loadIndex();
  if (!idx) return true;
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::INT AS n FROM tracks WHERE plays > 0`);
  return idx.uris.length < (limit > 0 ? Math.min(limit, n) : n) * 0.8;
}

/** Runs only when enabled in Impostazioni, a key is set and the map is missing or too small. */
export async function autoEmbeddings(): Promise<void> {
  const s = getApp().settings;
  if (!s.autoEmbeddings || !embeddingsAvailable() || ctrl || isEnrichmentHeld()) return;
  if (!(await embeddingsStale(s.autoEmbeddingsLimit))) return;
  await startEmbeddings(s.autoEmbeddingsLimit);
}

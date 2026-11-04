import { query, upsertMeta, setClusters } from '../data/db';
import { idb } from '../lib/idb';
import { getApp } from '../lib/store';
import type { MlRequest, MlResponse } from './ml.worker';

export const EMBED_MODELS = {
  gemma: {
    id: 'onnx-community/embeddinggemma-2-ONNX',
    dtype: 'q4',
    dim: 256,
    label: 'EmbeddingGemma 2 (qualità, ~175 MB, multilingue)',
    queryPrefix: 'task: search result | query: ',
    docPrefix: (title: string) => `title: ${title} | text: `,
  },
  mini: {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dtype: 'q8',
    dim: 384,
    label: 'MiniLM multilingue (veloce, ~120 MB)',
    queryPrefix: '',
    docPrefix: (title: string) => `${title}. `,
  },
} as const;
export type EmbedModelKey = keyof typeof EMBED_MODELS;

export interface EmbIndex {
  model: EmbedModelKey;
  dim: number;
  uris: string[];
  vecs: Float32Array;
  builtAt: number;
}

let worker: Worker | null = null;
let loadedModel: EmbedModelKey | null = null;
let reqId = 0;
const waiters = new Map<number, { resolve: (m: MlResponse) => void; reject: (e: Error) => void }>();
let progressCb: ((stage: string, loaded?: number, total?: number) => void) | null = null;
let loadWaiter: { resolve: (device: string) => void; reject: (e: Error) => void } | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./ml.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<MlResponse>) => {
    const m = e.data;
    if (m.type === 'progress') progressCb?.(m.stage, m.loaded, m.total);
    else if (m.type === 'loaded') {
      loadWaiter?.resolve(m.device);
      loadWaiter = null;
    } else if (m.type === 'error') {
      if (m.id != null) waiters.get(m.id)?.reject(new Error(m.message));
      else {
        loadWaiter?.reject(new Error(m.message));
        loadWaiter = null;
      }
      if (m.id != null) waiters.delete(m.id);
    } else if ('id' in m) {
      waiters.get(m.id)?.resolve(m);
      waiters.delete(m.id);
    }
  };
  return worker;
}

type WithoutId<U> = U extends unknown ? Omit<U, 'id'> : never;
function call<T extends MlResponse>(msg: WithoutId<Extract<MlRequest, { id: number }>>, transfer: Transferable[] = []): Promise<T> {
  const id = ++reqId;
  return new Promise<T>((resolve, reject) => {
    waiters.set(id, { resolve: resolve as (m: MlResponse) => void, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

async function ensureModel(key: EmbedModelKey): Promise<string> {
  if (loadedModel === key) return 'cached';
  const m = EMBED_MODELS[key];
  getApp().logNet('huggingface.co', 'modello embeddings (una tantum)');
  const device = await new Promise<string>((resolve, reject) => {
    loadWaiter = { resolve, reject };
    getWorker().postMessage({ type: 'load', model: m.id, dtype: m.dtype, dim: m.dim } satisfies MlRequest);
  });
  loadedModel = key;
  return device;
}

export async function embedTexts(texts: string[], key: EmbedModelKey): Promise<{ vecs: Float32Array; dim: number }> {
  await ensureModel(key);
  const r = await call<Extract<MlResponse, { type: 'embedded' }>>({ type: 'embed', texts });
  return { vecs: r.vecs, dim: r.dim };
}

// ---------- index persistence ----------

let indexCache: EmbIndex | null | undefined;

export async function loadIndex(): Promise<EmbIndex | null> {
  if (indexCache !== undefined) return indexCache;
  indexCache = (await idb.get<EmbIndex>('emb_index')) ?? null;
  return indexCache;
}

export function clearIndexCache() {
  indexCache = undefined;
}

interface DocRow {
  uri: string;
  track: string;
  artist: string;
  album: string;
  tags: string | null;
  lyrics: string | null;
}

function buildDoc(r: DocRow, key: EmbedModelKey): string {
  const m = EMBED_MODELS[key];
  const parts = [`${r.track} — ${r.artist}`];
  if (r.album) parts.push(`album: ${r.album}`);
  if (r.tags) parts.push(`generi: ${r.tags}`);
  if (r.lyrics && r.lyrics !== '[strumentale]') parts.push(`testo: ${r.lyrics.replace(/\s+/g, ' ').slice(0, 700)}`);
  else if (r.lyrics === '[strumentale]') parts.push('brano strumentale');
  return m.docPrefix(`${r.artist} - ${r.track}`) + parts.join('. ');
}

/** Embeds the top-N tracks (by listening time), then computes a 2D map and clusters. */
export async function buildIndex(
  key: EmbedModelKey,
  limit: number,
  onProgress: (stage: string, done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<EmbIndex> {
  progressCb = (stage, loaded, total) => onProgress(stage, loaded ?? 0, total ?? 0);
  onProgress('Preparazione', 0, 1);
  const device = await ensureModel(key);
  const rows = await query<DocRow>(
    `SELECT t.uri, t.track, t.artist, t.album, m.tags, m.lyrics FROM tracks t LEFT JOIN meta m USING (uri)
     WHERE t.plays > 0 ORDER BY t.minutes DESC LIMIT ${Math.max(10, Math.floor(limit))}`,
  );
  const dim = EMBED_MODELS[key].dim;
  const vecs = new Float32Array(rows.length * dim);
  const B = device === 'webgpu' ? 32 : 16;
  for (let i = 0; i < rows.length; i += B) {
    if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
    const batch = rows.slice(i, i + B);
    const r = await embedTexts(batch.map((x) => buildDoc(x, key)), key);
    vecs.set(r.vecs.subarray(0, batch.length * dim), i * dim);
    onProgress(`Embedding brani (${device === 'webgpu' ? 'GPU' : 'CPU'})`, Math.min(i + B, rows.length), rows.length);
  }
  const index: EmbIndex = { model: key, dim, uris: rows.map((r) => r.uri), vecs, builtAt: Date.now() };
  await idb.set('emb_index', index);
  indexCache = index;
  await computeLayout(index, onProgress);
  progressCb = null;
  return index;
}

/** Hybrid vectors for layout: text embedding + (when known) audio features. */
async function hybridVectors(index: EmbIndex): Promise<{ vecs: Float32Array; dim: number }> {
  const feats = await query<{ uri: string; valence: number | null; energy: number | null; danceability: number | null; acousticness: number | null }>(
    `SELECT uri, valence, energy, danceability, acousticness FROM meta WHERE valence IS NOT NULL`,
  );
  const fm = new Map(feats.map((f) => [f.uri, f]));
  const extra = 4;
  const w = 0.35 / Math.sqrt(extra);
  const dim = index.dim + extra;
  const out = new Float32Array(index.uris.length * dim);
  index.uris.forEach((u, i) => {
    out.set(index.vecs.subarray(i * index.dim, (i + 1) * index.dim), i * dim);
    const f = fm.get(u);
    const vals = [f?.valence ?? 0.5, f?.energy ?? 0.5, f?.danceability ?? 0.5, f?.acousticness ?? 0.5];
    vals.forEach((v, j) => (out[i * dim + index.dim + j] = (v - 0.5) * w * 2));
  });
  return { vecs: out, dim };
}

export async function computeLayout(index: EmbIndex, onProgress: (stage: string, done: number, total: number) => void) {
  progressCb = (stage, loaded, total) => onProgress(stage, loaded ?? 0, total ?? 0);
  const n = index.uris.length;
  const { vecs, dim } = await hybridVectors(index);
  const um = await call<Extract<MlResponse, { type: 'umap' }>>(
    { type: 'umap', vecs: vecs.slice(), n, dim, seed: 42 },
  );
  const km = await call<Extract<MlResponse, { type: 'kmeans' }>>(
    { type: 'kmeans', vecs: vecs.slice(), n, dim, kMin: 5, kMax: Math.min(14, Math.max(5, Math.round(Math.sqrt(n / 20)))), seed: 7 },
  );
  await upsertMeta(
    index.uris.map((uri, i) => ({ uri, x: um.xy[i * 2], y: um.xy[i * 2 + 1], cluster: km.labels[i] })),
  );
  await labelClusters();
  progressCb = null;
  getApp().bump();
}

/** Default cluster labels from Last.fm tags (if any) or the 2 most-listened artists. */
export async function labelClusters() {
  const rows = await query<{ cluster: number; artists: string; tags: string | null }>(`
    WITH a AS (
      SELECT m.cluster, t.artist, sum(t.minutes) AS mins FROM tracks t JOIN meta m USING (uri)
      WHERE m.cluster IS NOT NULL GROUP BY ALL
    ), ra AS (
      SELECT cluster, string_agg(artist, ' · ' ORDER BY mins DESC) FILTER (WHERE rn <= 2) AS artists
      FROM (SELECT *, row_number() OVER (PARTITION BY cluster ORDER BY mins DESC) AS rn FROM a) GROUP BY cluster
    ), tg AS (
      SELECT cluster, string_agg(tag, ', ' ORDER BY c DESC) FILTER (WHERE rn <= 2) AS tags FROM (
        SELECT cluster, tag, count(*) AS c, row_number() OVER (PARTITION BY cluster ORDER BY count(*) DESC) AS rn
        FROM (SELECT m.cluster, trim(unnest(string_split(m.tags, ','))) AS tag FROM meta m WHERE m.cluster IS NOT NULL AND m.tags <> '')
        GROUP BY cluster, tag
      ) GROUP BY cluster
    )
    SELECT ra.cluster, ra.artists, tg.tags FROM ra LEFT JOIN tg USING (cluster) ORDER BY cluster`);
  const prev = new Map(((await idb.get<Array<{ id: number; label: string; custom?: boolean }>>('clusters')) ?? []).map((c) => [c.id, c]));
  await setClusters(
    rows.map((r) => {
      const p = prev.get(r.cluster);
      if (p?.custom) return p;
      const label = r.tags ? r.tags.replace(/\b\w/g, (c) => c.toUpperCase()) : r.artists;
      return { id: r.cluster, label };
    }),
  );
}

// ---------- search ----------

export function dot(a: Float32Array, ai: number, b: Float32Array, bi: number, dim: number) {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[ai * dim + i] * b[bi * dim + i];
  return s;
}

export function topK(index: EmbIndex, q: Float32Array, k: number, exclude?: Set<string>, restrict?: Set<string>) {
  const scores: Array<{ uri: string; score: number }> = [];
  for (let i = 0; i < index.uris.length; i++) {
    const u = index.uris[i];
    if (exclude?.has(u) || (restrict && !restrict.has(u))) continue;
    scores.push({ uri: u, score: dot(index.vecs, i, q, 0, index.dim) });
  }
  return scores.sort((a, b) => b.score - a.score).slice(0, k);
}

export async function semanticSearch(text: string, k = 30, restrict?: Set<string>) {
  const index = await loadIndex();
  if (!index) throw new Error('Indice semantico non ancora creato: vai su Mood & Galassia → "Crea mappa".');
  const m = EMBED_MODELS[index.model];
  const { vecs } = await embedTexts([m.queryPrefix + text], index.model);
  return topK(index, vecs, k, undefined, restrict);
}

export async function similarTo(uri: string, k = 12) {
  const index = await loadIndex();
  if (!index) return [];
  const i = index.uris.indexOf(uri);
  if (i < 0) return [];
  const q = index.vecs.slice(i * index.dim, (i + 1) * index.dim);
  return topK(index, q, k, new Set([uri]));
}

/** Mean vector of a set of tracks (weighted). */
export function centroid(index: EmbIndex, weights: Map<string, number>): Float32Array | null {
  const c = new Float32Array(index.dim);
  let tot = 0;
  index.uris.forEach((u, i) => {
    const w = weights.get(u);
    if (!w) return;
    tot += w;
    for (let j = 0; j < index.dim; j++) c[j] += index.vecs[i * index.dim + j] * w;
  });
  if (!tot) return null;
  let n = 0;
  for (let j = 0; j < index.dim; j++) n += c[j] * c[j];
  n = Math.sqrt(n) || 1;
  for (let j = 0; j < index.dim; j++) c[j] /= n;
  return c;
}

export async function similarArtists(artist: string, k = 8) {
  const index = await loadIndex();
  if (!index) return [];
  const rows = await query<{ uri: string; artist: string; minutes: number }>(
    `SELECT uri, artist, minutes FROM tracks`,
  );
  const byArtist = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!byArtist.has(r.artist)) byArtist.set(r.artist, new Map());
    byArtist.get(r.artist)!.set(r.uri, Math.sqrt(r.minutes));
  }
  const target = byArtist.get(artist);
  if (!target) return [];
  const tc = centroid(index, target);
  if (!tc) return [];
  const out: Array<{ artist: string; score: number }> = [];
  for (const [a, w] of byArtist) {
    if (a === artist) continue;
    const c = centroid(index, w);
    if (!c) continue;
    let s = 0;
    for (let j = 0; j < index.dim; j++) s += c[j] * tc[j];
    out.push({ artist: a, score: s });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

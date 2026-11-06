// Mood estimation for tracks without measured audio features: an LLM via OpenRouter (few-shot anchors,
// JSON schema). Not trusted by default: llm/moodBench.ts measures it against held-out measured tracks, and
// estimates are written only when the benchmark says they beat a constant guess.
// (Levanto Sage was benchmarked on the same tracks in Nov 2026 and did not beat the LLM: removed.)
import { query, upsertMeta } from '../data/db';
import type { MetaRow } from '../data/schema';
import { kv } from '../lib/kv';
import { getApp } from '../lib/store';
import { structured } from './client';
import { MOOD_CENTER } from '../lib/mood';
import type { MoodBench } from './moodBench';
import { aiCacheGet, aiCachePut, promptVersion } from '../lib/aiCache';

export interface Item {
  uri: string;
  track: string;
  artist: string;
  tags: string | null;
  lyrics: string | null;
  valence?: number;
  energy?: number;
}

export interface Estimate {
  valence: number | null;
  energy: number | null;
  /** Provider-side agreement/confidence (0–1). Not accuracy: accuracy comes from the benchmark. */
  agreement: number;
}

export interface MoodRunReport {
  analyzed: number;
  anchors: number;
  model: string;
  at: number;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'valence', 'energy', 'evidence'],
        properties: {
          id: { type: 'string' },
          valence: { type: 'number', minimum: 0, maximum: 1 },
          energy: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

// No "stay near typical values" instruction: it shrank every estimate towards the mean, which looked
// cautious but destroyed the signal (measured r ≈ 0 on held-out tracks).
const SYSTEM = `Sei un esperto di Music Emotion Recognition. Per ogni brano stimi due valori continui da 0 a 1, sulla stessa scala delle audio features di Spotify:
- valence: positività emotiva percepita della MUSICA e del testo (0 = cupo/triste/rabbioso, 1 = gioioso/euforico/sereno).
- energy: intensità/arousal percepita (0 = calmo, acustico, lento; 1 = intenso, veloce, forte).
Se conosci il brano, usa ciò che sai di come SUONA (tempo, arrangiamento, tonalità), non solo il testo.
Calibra le stime sui BRANI DI RIFERIMENTO forniti: i loro valori sono misurati sull'audio e definiscono la scala. Usa tutta la scala quando il brano lo giustifica.
"evidence" = max 12 parole sul perché. Rispondi solo con il JSON richiesto, con un elemento per ogni id ricevuto.`;

export const clip = (s: string | null, n: number) => (s ? s.replace(/\s+/g, ' ').slice(0, n) : '');

export function describe(i: Item, withLyrics = 380) {
  const bits = [`"${i.track}" — ${i.artist}`];
  if (i.tags) bits.push(`tag: ${i.tags}`);
  if (i.lyrics === '[strumentale]') bits.push('strumentale');
  else if (i.lyrics) bits.push(`testo: ${clip(i.lyrics, withLyrics)}`);
  return bits.join(' | ');
}

export function pickAnchors(pool: Item[], n: number): Item[] {
  // Stratify on the 4 quadrants, prefer anchors with textual signal.
  const q = (i: Item) => (i.valence! > MOOD_CENTER.valence ? 1 : 0) + (i.energy! > MOOD_CENTER.energy ? 2 : 0);
  const buckets: Item[][] = [[], [], [], []];
  for (const i of [...pool].sort((a, b) => Number(!!b.lyrics || !!b.tags) - Number(!!a.lyrics || !!a.tags))) buckets[q(i)].push(i);
  const out: Item[] = [];
  let k = 0;
  while (out.length < n && buckets.some((b) => b.length)) {
    const b = buckets[k++ % 4];
    if (b.length) out.push(b.shift()!);
  }
  return out;
}

export const anchorLines = (anchors: Item[]) =>
  anchors.map((a) => `- ${describe(a, 160)} ⇒ valence ${a.valence!.toFixed(2)}, energy ${a.energy!.toFixed(2)}`).join('\n');

/** Tracks with measured (audio) valence/energy: anchors for the estimators and ground truth for the benchmark. */
export async function measuredTracks(limit = 5000): Promise<Item[]> {
  return query<Item>(
    `SELECT t.uri, t.track, t.artist, m.tags, m.lyrics, coalesce(m.valence_audio, m.valence) AS valence, coalesce(m.energy_audio, m.energy) AS energy
     FROM tracks t JOIN meta m USING (uri)
     WHERE m.mood_source = 'reccobeats' AND m.valence IS NOT NULL AND m.energy IS NOT NULL ORDER BY t.minutes DESC LIMIT ${Math.floor(limit)}`,
  );
}

// Cache keys: a change to the prompt, the schema or the text format gives a new version → fresh estimates.
const MOOD_VERSION = promptVersion(SYSTEM, SCHEMA, 'describe:380|anchors:160|B:12');
const LYRICS_VERSION = () => promptVersion(LYRICS_SYSTEM, LYRICS_SCHEMA, 'clip:700|B:15');

/** Runs one estimator over `items` in batches. Returns uri → estimate.
 *  Songs already estimated by the same model and prompt (any analysis, any person) come from the shared cache: no new call. */
export async function estimateMood(
  allItems: Item[],
  anchors: Item[],
  opts: {
    samples?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    onBatch?: (b: Map<string, Estimate>) => Promise<void>;
    /** 'mood_bench' keeps benchmark estimates (always made with artist-disjoint anchors) apart from regular ones. */
    cacheKind?: 'mood' | 'mood_bench';
  },
): Promise<Map<string, Estimate>> {
  const out = new Map<string, Estimate>();
  const model = getApp().settings.llmModelBulk;
  const cacheKey = { kind: opts.cacheKind ?? 'mood', model, version: MOOD_VERSION };
  const cached = await aiCacheGet<Estimate>(cacheKey, allItems.map((i) => i.uri));
  const hits = new Map<string, Estimate>();
  for (const i of allItems) {
    const c = cached.get(i.uri);
    if (c && c.valence != null) hits.set(i.uri, c);
  }
  for (const [k, v] of hits) out.set(k, v);
  if (hits.size) await opts.onBatch?.(hits);
  const items = allItems.filter((i) => !hits.has(i.uri));
  const total = allItems.length;

  const B = 12;
  const batches: Item[][] = [];
  for (let i = 0; i < items.length; i += B) batches.push(items.slice(i, i + B));
  const anchorText = anchors.length ? anchorLines(anchors) : '(nessun riferimento misurato disponibile)';
  const samples = Math.max(1, opts.samples ?? 1);
  let cursor = 0;
  let done = hits.size;
  opts.onProgress?.(done, total);

  const runBatch = async (batch: Item[]): Promise<Map<string, Estimate>> => {
    const res = new Map<string, Estimate>();
    const ids = new Map(batch.map((t, i) => [`t${i}`, t]));
    const user = `BRANI DI RIFERIMENTO (valori misurati):\n${anchorText}\n\nBRANI DA STIMARE:\n${batch.map((t, i) => `[t${i}] ${describe(t)}`).join('\n')}`;
    const acc = new Map<string, { v: number[]; e: number[] }>();
    for (let s = 0; s < samples; s++) {
      const r = await structured<{ results: Array<{ id: string; valence: number; energy: number }> }>({
        model,
        system: SYSTEM,
        user,
        schemaName: 'mood_estimates',
        schema: SCHEMA,
        temperature: samples > 1 ? 0.7 : 0.2,
        signal: opts.signal,
      });
      for (const x of r.results ?? []) {
        const t = ids.get(x.id);
        if (!t || !Number.isFinite(Number(x.valence)) || !Number.isFinite(Number(x.energy))) continue;
        const p = acc.get(t.uri) ?? { v: [], e: [] };
        p.v.push(Math.min(1, Math.max(0, Number(x.valence))));
        p.e.push(Math.min(1, Math.max(0, Number(x.energy))));
        acc.set(t.uri, p);
      }
    }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    for (const [uri, p] of acc) {
      const spread = p.v.length > 1 ? (Math.max(...p.v) - Math.min(...p.v) + Math.max(...p.e) - Math.min(...p.e)) / 2 : 0.25;
      res.set(uri, { valence: avg(p.v), energy: avg(p.e), agreement: Math.max(0, 1 - spread * 2) });
    }
    return res;
  };

  const worker = async () => {
    while (cursor < batches.length && !opts.signal?.aborted) {
      const batch = batches[cursor++];
      let res: Map<string, Estimate> | null = null;
      for (let attempt = 0; attempt < 3 && !res && !opts.signal?.aborted; attempt++) {
        try {
          res = await runBatch(batch);
        } catch (e) {
          if (opts.signal?.aborted) return;
          console.warn('mood batch failed', e);
          await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
        }
      }
      if (res) {
        for (const [k, v] of res) out.set(k, v);
        await aiCachePut(cacheKey, [...res].map(([uri, value]) => ({ uri, value })));
        await opts.onBatch?.(res);
      }
      done += batch.length;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

export async function moodCandidates(limit: number) {
  return query<Item>(
    `SELECT t.uri, t.track, t.artist, m.tags, m.lyrics FROM tracks t LEFT JOIN meta m USING (uri)
     WHERE (m.mood_source IS NULL OR m.mood_source IN ('llm_pending', 'llm_rejected')) AND t.plays > 0
       AND ((m.lyrics IS NOT NULL AND m.lyrics <> '') OR (m.tags IS NOT NULL AND m.tags <> ''))
     ORDER BY t.minutes DESC LIMIT ${Math.floor(limit)}`,
  );
}

/**
 * Estimates mood for tracks without audio features, writing only the dimensions the benchmark validated.
 * mood_conf = benchmark skill on valence (share of the constant baseline's error removed) × provider agreement.
 */
export async function runMoodV2(opts: {
  limit: number;
  samples: 1 | 2 | 3;
  bench: MoodBench;
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
}): Promise<MoodRunReport> {
  const model = getApp().settings.llmModelBulk;
  const pr = opts.bench.providers.find((p) => p.model === model);
  if (!pr?.useful.valence) throw new Error('Il benchmark non ha validato questo stimatore: nessuna stima scritta.');
  const anchors = pickAnchors(await measuredTracks(400), 40);
  const targets = await moodCandidates(opts.limit);
  const skill = Math.max(0, Math.min(1, pr.valence.skill));
  let analyzed = 0;
  await estimateMood(targets, anchors, {
    samples: opts.samples,
    signal: opts.signal,
    onProgress: opts.onProgress,
    onBatch: async (res) => {
      const rows: MetaRow[] = [];
      for (const [uri, e] of res) {
        if (e.valence == null) continue;
        rows.push({
          uri,
          valence: e.valence,
          energy: pr.useful.energy ? e.energy : null,
          mood_source: 'llm',
          mood_conf: skill * (0.5 + 0.5 * e.agreement),
        });
      }
      analyzed += rows.length;
      if (rows.length) await upsertMeta(rows);
    },
  });
  const report: MoodRunReport = { analyzed, anchors: anchors.length, model, at: Date.now() };
  await kv.set('mood_report', report);
  getApp().bump();
  return report;
}

/** Withdraws AI estimates that failed the benchmark: values cleared, tracks can be re-estimated by a better provider. */
export async function rejectAiEstimates(source = 'llm'): Promise<number> {
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::INT AS n FROM meta WHERE mood_source = '${source}'`);
  if (!n) return 0;
  const rows = await query<{ uri: string }>(`SELECT uri FROM meta WHERE mood_source = '${source}'`);
  await upsertMeta(rows.map((r) => ({ uri: r.uri, valence: null, energy: null, mood_conf: null, mood_source: 'llm_rejected' })));
  return n;
}

// ---------- Lyrics-only valence (fused with audio valence in data/moodAdjust.ts) ----------

const LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'valence'],
        properties: { id: { type: 'string' }, valence: { type: 'number', minimum: 0, maximum: 1 } },
      },
    },
  },
};

const LYRICS_SYSTEM = `Valuti SOLO il TESTO di ogni brano (non la musica, non la fama del brano).
valence = positività emotiva del testo da 0 a 1: 0 = disperato, triste, rabbioso, cupo; 0.5 = neutro, ambivalente o descrittivo; 1 = gioioso, amorevole, euforico.
Testi agrodolci o nostalgici stanno tra 0.3 e 0.45. Se il testo è troppo breve o incomprensibile, rispondi 0.5.
Rispondi solo con il JSON richiesto, un elemento per ogni id.`;

export async function lyricsValenceCandidates(limit: number) {
  return query<{ uri: string; track: string; artist: string; lyrics: string }>(
    `SELECT t.uri, t.track, t.artist, m.lyrics FROM tracks t JOIN meta m USING (uri)
     WHERE m.valence_audio IS NOT NULL AND m.valence_lyrics IS NULL
       AND m.lyrics IS NOT NULL AND length(m.lyrics) > 80 AND m.lyrics <> '[strumentale]' AND t.plays > 0
     ORDER BY t.minutes DESC LIMIT ${Math.floor(limit)}`,
  );
}

/** Scores lyric valence for tracks that already have measured audio features. Returns how many were scored. */
export async function runLyricsValence(opts: { limit: number; signal: AbortSignal; onProgress: (done: number, total: number) => void }): Promise<number> {
  const model = getApp().settings.llmModelBulk;
  const all = await lyricsValenceCandidates(opts.limit);
  const cacheKey = { kind: 'lyrics_valence', model, version: LYRICS_VERSION() };
  const cached = await aiCacheGet<number>(cacheKey, all.map((t) => t.uri));
  const fromCache: MetaRow[] = all.filter((t) => Number.isFinite(cached.get(t.uri))).map((t) => ({ uri: t.uri, valence_lyrics: cached.get(t.uri)! }));
  if (fromCache.length) await upsertMeta(fromCache);
  const targets = all.filter((t) => !Number.isFinite(cached.get(t.uri)));
  const B = 15;
  const batches: (typeof targets)[] = [];
  for (let i = 0; i < targets.length; i += B) batches.push(targets.slice(i, i + B));
  let done = fromCache.length;
  let scored = fromCache.length;
  let cursor = 0;
  opts.onProgress(done, all.length);
  const worker = async () => {
    while (cursor < batches.length && !opts.signal.aborted) {
      const batch = batches[cursor++];
      const ids = new Map(batch.map((t, i) => [`t${i}`, t]));
      const user = batch.map((t, i) => `[t${i}] "${t.track}" — ${t.artist}\n${clip(t.lyrics, 700)}`).join('\n\n');
      try {
        const r = await structured<{ results: Array<{ id: string; valence: number }> }>({
          model,
          system: LYRICS_SYSTEM,
          user,
          schemaName: 'lyrics_valence',
          schema: LYRICS_SCHEMA,
          temperature: 0.2,
          signal: opts.signal,
        });
        const rows: MetaRow[] = [];
        for (const x of r.results ?? []) {
          const t = ids.get(x.id);
          if (t && Number.isFinite(Number(x.valence))) rows.push({ uri: t.uri, valence_lyrics: Math.min(1, Math.max(0, Number(x.valence))) });
        }
        if (rows.length) {
          await upsertMeta(rows);
          await aiCachePut(cacheKey, rows.map((r) => ({ uri: r.uri, value: r.valence_lyrics as number })));
        }
        scored += rows.length;
      } catch (e) {
        if (opts.signal.aborted) return;
        console.warn('lyrics valence batch failed', e);
      }
      done += batch.length;
      opts.onProgress(done, all.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return scored;
}

import { query, upsertMeta } from '../data/db';
import type { MetaRow } from '../data/schema';
import { idb } from '../lib/idb';
import { getApp, type ConnectionId } from '../lib/store';
import { sleep } from './net';
import { cacheCatalog } from '../lib/catalogCache';
import { fetchAudioFeatures, fetchCover, fetchLyrics, fetchTags, type TrackRef } from './providers';

export type StepId = 'covers' | 'audiofeatures' | 'lyrics' | 'tags';

interface StepDef {
  label: string;
  connection: ConnectionId;
  column: string; // meta column that marks "done" when NOT NULL
  batch: number;
  concurrency: number;
  filter?: string; // extra SQL condition on tracks t
  /** Optional custom pending-items query (must return TrackRef columns, ordered by priority). */
  itemsSql?: string;
  run: (items: TrackRef[], signal: AbortSignal) => Promise<MetaRow[]>;
}

const one =
  (fn: (t: TrackRef, s: AbortSignal) => Promise<MetaRow | null>) =>
  async (items: TrackRef[], s: AbortSignal) => {
    const out: MetaRow[] = [];
    for (const t of items) {
      const r = await fn(t, s);
      if (r) out.push(r);
    }
    return out;
  };

export const STEPS: Record<StepId, StepDef> = {
  covers: {
    label: 'Copertine',
    connection: 'covers',
    column: 'cover',
    batch: 1,
    concurrency: 2,
    // One request per album (covers are per album) → ~3× fewer calls, fewer rate limits.
    itemsSql: `SELECT arg_max(t.uri, t.minutes) AS uri, arg_max(t.track, t.minutes) AS track, t.artist, t.album, NULL AS duration_ms
      FROM tracks t LEFT JOIN meta m USING (uri)
      WHERE m.cover IS NULL AND t.plays > 0 AND t.uri LIKE 'spotify:track:%'
      GROUP BY t.artist, t.album ORDER BY sum(t.minutes) DESC`,
    run: async (items, s) => {
      const out: MetaRow[] = [];
      for (const t of items) {
        const r = await fetchCover(t, s);
        if (!r) continue;
        const siblings = await query<{ uri: string }>(
          `SELECT uri FROM tracks WHERE artist = ? AND album = ? AND uri LIKE 'spotify:track:%'`,
          [t.artist, t.album],
        );
        for (const x of siblings) out.push({ uri: x.uri, cover: r.cover });
        if (!siblings.length) out.push(r);
        await sleep(120, s).catch(() => undefined);
      }
      return out;
    },
  },
  audiofeatures: {
    label: 'Audio features (valence, energia)',
    connection: 'audiofeatures',
    column: 'mood_source',
    batch: 40,
    concurrency: 2,
    filter: `t.uri LIKE 'spotify:track:%'`,
    run: fetchAudioFeatures,
  },
  lyrics: {
    label: 'Testi',
    connection: 'lyrics',
    column: 'lyrics',
    batch: 1,
    concurrency: 2,
    filter: `t.plays >= 2`,
    run: one(fetchLyrics),
  },
  tags: {
    label: 'Tag e generi',
    connection: 'lastfm',
    column: 'tags',
    batch: 1,
    concurrency: 3,
    run: (items, s) => one((t, sig) => fetchTags(t, getApp().settings.lastfmKey, sig))(items, s),
  },
};

const controllers = new Map<StepId, AbortController>();
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBump() {
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    getApp().bump();
  }, 2500);
}

export function isRunning(step: StepId) {
  return controllers.has(step);
}

export function stopStep(step: StepId) {
  controllers.get(step)?.abort();
}

export function stopAll() {
  for (const c of controllers.values()) c.abort();
}

export async function pendingCount(step: StepId): Promise<number> {
  const d = STEPS[step];
  const tried = new Set((await idb.get<string[]>(`tried:${step}`)) ?? []);
  const rows = await query<{ uri: string }>(
    d.itemsSql ??
      `SELECT t.uri FROM tracks t LEFT JOIN meta m USING (uri) WHERE m.${d.column} IS NULL AND t.plays > 0 ${d.filter ? 'AND ' + d.filter : ''}`,
  );
  return rows.filter((r) => !tried.has(r.uri)).length;
}

/** Runs one enrichment step over all pending tracks (ordered by listening time). Resumable. */
export async function runStep(step: StepId, limit = Infinity): Promise<void> {
  if (controllers.has(step)) return;
  const app = getApp();
  const d = STEPS[step];
  if (!app.settings.connections[d.connection]) return;
  if (step === 'tags' && !app.settings.lastfmKey) return;

  const ctrl = new AbortController();
  controllers.set(step, ctrl);
  const triedArr = (await idb.get<string[]>(`tried:${step}`)) ?? [];
  const tried = new Set(triedArr);
  try {
    const rows = await query<TrackRef>(
      d.itemsSql ??
        `SELECT t.uri, t.track, t.artist, t.album, t.duration_ms FROM tracks t LEFT JOIN meta m USING (uri)
       WHERE m.${d.column} IS NULL AND t.plays > 0 ${d.filter ? 'AND ' + d.filter : ''}
       ORDER BY t.minutes DESC`,
    );
    const items = rows.filter((r) => !tried.has(r.uri)).slice(0, limit);
    const total = items.length;
    let done = 0;
    const job = (status: 'running' | 'done' | 'paused' | 'error', detail?: string) =>
      app.setJob({ id: step, label: d.label, done, total, status, detail });
    job('running');
    if (!total) {
      job('done');
      return;
    }

    const batches: TrackRef[][] = [];
    for (let i = 0; i < items.length; i += d.batch) batches.push(items.slice(i, i + d.batch));
    let cursor = 0;
    let pending: MetaRow[] = [];
    let lastFlush = Date.now();
    let fails = 0;

    const flush = async () => {
      const rowsToWrite = pending;
      pending = [];
      lastFlush = Date.now();
      if (rowsToWrite.length) {
        await upsertMeta(rowsToWrite);
        // Public catalog data is also kept in a shared local cache (survives other exports / data wipes).
        if (step === 'covers' || step === 'audiofeatures') void cacheCatalog(rowsToWrite).catch(() => undefined);
        scheduleBump();
      }
      await idb.set(`tried:${step}`, Array.from(tried));
    };

    const worker = async () => {
      while (cursor < batches.length && !ctrl.signal.aborted) {
        const b = batches[cursor++];
        // Retry transient failures (rate limits often surface as CORS-less 429 → TypeError).
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await d.run(b, ctrl.signal);
            pending.push(...res);
            fails = 0;
            break;
          } catch (e) {
            if (ctrl.signal.aborted) return;
            if (attempt < 3) {
              await sleep(2000 * 2 ** attempt + Math.random() * 500, ctrl.signal).catch(() => undefined);
              continue;
            }
            fails++;
            if (fails > 8) throw e;
            break;
          }
        }
        for (const t of b) tried.add(t.uri);
        done += b.length;
        job('running');
        if (pending.length >= 50 || Date.now() - lastFlush > 3000) await flush();
      }
    };

    await Promise.all(Array.from({ length: d.concurrency }, worker));
    await flush();
    job(ctrl.signal.aborted ? 'paused' : 'done');
  } catch (e) {
    app.setJob({ id: step, label: d.label, done: 0, total: 0, status: 'error', detail: e instanceof Error ? e.message : String(e) });
  } finally {
    controllers.delete(step);
    getApp().bump();
  }
}

/** Starts every enabled step in parallel (different hosts → no shared rate limit). */
export function runAllEnabled() {
  const s = getApp().settings;
  if (s.connections.covers) void runStep('covers');
  if (s.connections.audiofeatures) void runStep('audiofeatures');
  if (s.connections.lyrics) void runStep('lyrics', 1500);
  if (s.connections.lastfm && s.lastfmKey) void runStep('tags', 3000);
}

export async function resetTried() {
  await Promise.all((Object.keys(STEPS) as StepId[]).map((s) => idb.del(`tried:${s}`)));
}

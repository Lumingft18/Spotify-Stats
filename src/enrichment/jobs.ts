import { persistMeta, query, upsertMeta } from '../data/db';
import type { MetaRow } from '../data/schema';
import { idb } from '../lib/idb';
import { getApp, type ConnectionId } from '../lib/store';
import { sleep } from './net';
import { cacheCatalog } from '../lib/catalogCache';
import { autoMoodAi, stopMoodAi } from './moodAi';
import { autoEmbeddings, stopEmbeddings } from './embedAi';
import { isEnrichmentHeld } from './pause';
import { applyMoodAdjustments } from '../data/moodAdjust';
import { fetchArtistTagsMB, fetchAudioFeatures, fetchCover, fetchLyrics, fetchTags, type TrackRef } from './providers';

export type StepId = 'covers' | 'audiofeatures' | 'lyrics' | 'tags';

interface StepDef {
  label: string;
  connection: ConnectionId;
  column: string; // meta column that marks "done" when NOT NULL
  batch: number;
  concurrency: number;
  filter?: string; // extra SQL condition on tracks t
  /** Optional custom pending-items query (must return TrackRef columns, ordered by priority). */
  itemsSql?: string | (() => string);
  run: (items: TrackRef[], signal: AbortSignal) => Promise<MetaRow[]>;
}

const one =
  (fn: (t: TrackRef, s: AbortSignal) => Promise<MetaRow | null>) =>
  async (items: TrackRef[], s: AbortSignal) => {
    const out: MetaRow[] = [];
    for (const t of items) {
      const r = await fn(t, s);
      // null = transient failure (e.g. rate limited after retries): surface it so the item is retried later.
      if (r === null) throw new Error('richiesta non riuscita');
      out.push(r);
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
        if (!r) throw new Error('copertina non disponibile ora');
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
    // LRCLIB asks for sequential requests with a short pause; registered app ≈180/min.
    concurrency: 1,
    filter: `t.plays >= 2`,
    run: async (items, s) => {
      const out = await one(fetchLyrics)(items, s);
      await sleep(250, s).catch(() => undefined);
      return out;
    },
  },
  tags: {
    label: 'Tag e generi',
    connection: 'lastfm',
    column: 'tags',
    batch: 1,
    concurrency: 1,
    // With a Last.fm key: per-track tags. Without: per-artist genres from MusicBrainz (free, no key).
    itemsSql: () =>
      getApp().settings.lastfmKey
        ? `SELECT t.uri, t.track, t.artist, t.album, t.duration_ms FROM tracks t LEFT JOIN meta m USING (uri)
           WHERE m.tags IS NULL AND t.plays > 0 ORDER BY t.minutes DESC`
        : `SELECT arg_max(t.uri, t.minutes) AS uri, arg_max(t.track, t.minutes) AS track, t.artist, '' AS album, NULL AS duration_ms
           FROM tracks t LEFT JOIN meta m USING (uri) WHERE m.tags IS NULL AND t.plays > 0
           GROUP BY t.artist ORDER BY sum(t.minutes) DESC`,
    run: async (items, s) => {
      const key = getApp().settings.lastfmKey;
      if (key) return one((t, sig) => fetchTags(t, key, sig))(items, s);
      const out: MetaRow[] = [];
      for (const t of items) {
        const tags = await fetchArtistTagsMB(t.artist, s);
        const tracks = await query<{ uri: string }>(`SELECT uri FROM tracks WHERE artist = ?`, [t.artist]);
        for (const x of tracks) out.push({ uri: x.uri, tags });
        await sleep(1100, s).catch(() => undefined); // MusicBrainz: max ~1 req/s
      }
      return out;
    },
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
  stopMoodAi();
  stopEmbeddings();
}

export async function pendingCount(step: StepId): Promise<number> {
  const d = STEPS[step];
  const tried = new Set((await idb.get<string[]>(`tried:${step}`)) ?? []);
  const rows = await query<{ uri: string }>(
    (typeof d.itemsSql === 'function' ? d.itemsSql() : d.itemsSql) ??
      `SELECT t.uri FROM tracks t LEFT JOIN meta m USING (uri) WHERE m.${d.column} IS NULL AND t.plays > 0 ${d.filter ? 'AND ' + d.filter : ''}`,
  );
  return rows.filter((r) => !tried.has(r.uri)).length;
}

const inFlight = new Map<StepId, Promise<void>>();

/** Runs one enrichment step over all pending tracks (ordered by listening time). Resumable.
 *  If the step is already running, returns the in-flight run so callers can wait for it to finish. */
export function runStep(step: StepId, limit = Infinity): Promise<void> {
  const cur = inFlight.get(step);
  if (cur) return cur;
  const p = runStepNow(step, limit).finally(() => inFlight.delete(step));
  inFlight.set(step, p);
  return p;
}

async function runStepNow(step: StepId, limit: number): Promise<void> {
  if (controllers.has(step) || isEnrichmentHeld()) return;
  const app = getApp();
  const d = STEPS[step];
  if (!app.settings.connections[d.connection]) return;

  const ctrl = new AbortController();
  controllers.set(step, ctrl);
  const triedArr = (await idb.get<string[]>(`tried:${step}`)) ?? [];
  const tried = new Set(triedArr);
  try {
    const rows = await query<TrackRef>(
      (typeof d.itemsSql === 'function' ? d.itemsSql() : d.itemsSql) ??
        `SELECT t.uri, t.track, t.artist, t.album, t.duration_ms FROM tracks t LEFT JOIN meta m USING (uri)
       WHERE m.${d.column} IS NULL AND t.plays > 0 ${d.filter ? 'AND ' + d.filter : ''}
       ORDER BY t.minutes DESC`,
    );
    const pendingAll = rows.filter((r) => !tried.has(r.uri));
    const items = pendingAll.slice(0, limit);
    // Cumulative progress across reloads: a refresh resumes the count instead of restarting from 0.
    const progressKey = `progress:${step}`;
    const base = pendingAll.length ? ((await idb.get<number>(progressKey)) ?? 0) : 0;
    const total = base + pendingAll.length;
    let done = base;
    const job = (status: 'running' | 'done' | 'paused' | 'error', detail?: string) =>
      app.setJob({ id: step, label: d.label, done, total, status, detail });
    job('running');
    if (!items.length) {
      await idb.del(progressKey);
      job('done');
      return;
    }

    const batches: TrackRef[][] = [];
    for (let i = 0; i < items.length; i += d.batch) batches.push(items.slice(i, i + d.batch));
    let cursor = 0;
    let pending: MetaRow[] = [];
    let lastFlush = Date.now();
    let fails = 0;

    let lastSave = Date.now();
    let unsaved = false;
    const flush = async (final = false) => {
      const rowsToWrite = pending;
      pending = [];
      lastFlush = Date.now();
      if (rowsToWrite.length) {
        await upsertMeta(rowsToWrite, false);
        unsaved = true;
        // Public catalog data is also kept in a shared local cache (survives other exports / data wipes).
        if (step !== 'tags' || !getApp().settings.lastfmKey) void cacheCatalog(rowsToWrite).catch(() => undefined);
        scheduleBump();
      }
      // Save results BEFORE the "tried" list and progress, so a reload never skips items whose results were lost.
      if (final || Date.now() - lastSave > 10_000) {
        if (unsaved) await persistMeta();
        unsaved = false;
        lastSave = Date.now();
        await idb.setMany([
          [`tried:${step}`, Array.from(tried)],
          [progressKey, done],
        ]);
      }
    };

    const worker = async () => {
      while (cursor < batches.length && !ctrl.signal.aborted) {
        const b = batches[cursor++];
        // Retry transient failures (rate limits often surface as CORS-less 429 → TypeError).
        let ok = false;
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await d.run(b, ctrl.signal);
            pending.push(...res);
            fails = 0;
            ok = true;
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
        // Only successful lookups are remembered; failed ones (rate limits, network) are retried next run.
        if (ok) for (const t of b) tried.add(t.uri);
        done += b.length;
        job('running');
        if (pending.length >= 50 || Date.now() - lastFlush > 3000) await flush();
      }
    };

    await Promise.all(Array.from({ length: d.concurrency }, worker));
    await flush(true);
    if (!ctrl.signal.aborted && items.length === pendingAll.length) await idb.del(progressKey);
    if (step === 'audiofeatures') await applyMoodAdjustments();
    job(ctrl.signal.aborted ? 'paused' : 'done');
  } catch (e) {
    app.setJob({ id: step, label: d.label, done: 0, total: 0, status: 'error', detail: e instanceof Error ? e.message : String(e) });
  } finally {
    controllers.delete(step);
    getApp().bump();
  }
}

/** Earlier versions marked rate-limited lookups as "tried": forget those once so they are fetched again. */
async function migrateTried() {
  if ((await idb.get<number>('tried_version')) === 2) return;
  await Promise.all(['tried:lyrics', 'tried:tags', 'tried:covers'].map((k) => idb.del(k)));
  await idb.set('tried_version', 2);
}

/** Starts every enabled step in parallel (different hosts → no shared rate limit). */
export function runAllEnabled() {
  void migrateTried().then(runAllEnabledNow);
}

function runAllEnabledNow() {
  const s = getApp().settings;
  const runs: Array<Promise<void>> = [];
  if (s.connections.covers) void runStep('covers');
  if (s.connections.audiofeatures) {
    const af = runStep('audiofeatures');
    runs.push(af);
    // AI mood can start as soon as measured anchors exist, on the lyrics/tags already stored…
    void af.then(autoMoodAi);
  }
  // Most-listened first; ~10–15 min each at the providers' polite rates. "Avvia" in Attività continues past these caps.
  if (s.connections.lyrics) runs.push(runStep('lyrics', 1500));
  if (s.connections.lastfm) runs.push(runStep('tags', s.lastfmKey ? 3000 : 600));
  // …and runs again once this session's lyrics/tags are in, to cover the new candidates.
  // The taste map waits for lyrics/tags too: richer documents give better embeddings.
  void Promise.all(runs).then(() => Promise.all([autoMoodAi(), autoEmbeddings()]));
}

export async function resetTried() {
  await Promise.all((Object.keys(STEPS) as StepId[]).flatMap((s) => [idb.del(`tried:${s}`), idb.del(`progress:${s}`)]));
}

import { persistMeta, query, upsertMeta } from '../data/db';
import type { MetaRow } from '../data/schema';
import { kv } from '../lib/kv';
import { getApp, type ConnectionId } from '../lib/store';
import { sleep } from './net';
import { cacheCatalog, clearTriedShared, readCatalog, readTried, writeTried } from '../lib/catalogCache';
import { autoMoodAi, stopMoodAi } from './moodAi';
import { autoEmbeddings, stopEmbeddings } from './embedAi';
import { isEnrichmentHeld } from './pause';
import { applyMoodAdjustments } from '../data/moodAdjust';
import { markCompleteIfDone, markWork } from './completion';
import { advanceQueue, queueActiveId } from '../lib/importQueue';
import { currentAnalysisId } from '../lib/analyses';
import { fetchArtistTagsMB, fetchAudioFeatures, fetchCover, fetchLyrics, fetchTags, type TrackRef } from './providers';

export type StepId = 'covers' | 'audiofeatures' | 'lyrics' | 'tags';

/** Results of these steps go to the shared catalog, so "already looked up" can be shared too.
 *  Last.fm per-track tags stay private to the analysis (not cached), so their lookups are not shared. */
function sharedTriedKey(step: StepId): string | null {
  if (step === 'tags') return getApp().settings.lastfmKey ? null : 'tags:mb';
  return step;
}

async function loadTried(step: StepId, uris: string[]): Promise<Set<string>> {
  const tried = new Set((await kv.get<string[]>(`tried:${step}`)) ?? []);
  const shared = sharedTriedKey(step);
  if (shared) {
    const rest = uris.filter((u) => !tried.has(u));
    for (const u of await readTried(shared, rest).catch(() => [] as string[])) tried.add(u);
  }
  return tried;
}

interface StepDef {
  label: string;
  connection: ConnectionId;
  column: string; // meta column that marks "done" when NOT NULL
  batch: number;
  /** Parallel workers. Load on each host is capped by netFetch's pacing, not by this. */
  concurrency: number | (() => number);
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
    // Paced in netFetch at ≈180/min (registered LRCLIB client); 3 workers just hide the latency.
    concurrency: 3,
    run: one(fetchLyrics),
  },
  tags: {
    label: 'Tag e generi',
    connection: 'lastfm',
    column: 'tags',
    batch: 1,
    // Paced in netFetch: MusicBrainz 1/s, Last.fm 4/s. Workers only overlap the waiting on responses.
    concurrency: () => (getApp().settings.lastfmKey ? 4 : 2),
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
  const rows = await query<{ uri: string }>(
    (typeof d.itemsSql === 'function' ? d.itemsSql() : d.itemsSql) ??
      `SELECT t.uri FROM tracks t LEFT JOIN meta m USING (uri) WHERE m.${d.column} IS NULL AND t.plays > 0 ${d.filter ? 'AND ' + d.filter : ''}`,
  );
  const tried = await loadTried(step, rows.map((r) => r.uri));
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
  const sharedKey = sharedTriedKey(step);
  try {
    const rows = await query<TrackRef>(
      (typeof d.itemsSql === 'function' ? d.itemsSql() : d.itemsSql) ??
        `SELECT t.uri, t.track, t.artist, t.album, t.duration_ms FROM tracks t LEFT JOIN meta m USING (uri)
       WHERE m.${d.column} IS NULL AND t.plays > 0 ${d.filter ? 'AND ' + d.filter : ''}
       ORDER BY t.minutes DESC`,
    );
    const tried = await loadTried(step, rows.map((r) => r.uri));
    let triedNew: string[] = [];
    const pendingAll = rows.filter((r) => !tried.has(r.uri));
    const items = pendingAll.slice(0, limit);
    // Cumulative progress across reloads: a refresh resumes the count instead of restarting from 0.
    const progressKey = `progress:${step}`;
    const base = pendingAll.length ? ((await kv.get<number>(progressKey)) ?? 0) : 0;
    const total = base + pendingAll.length;
    let done = base;
    const job = (status: 'running' | 'done' | 'paused' | 'error', detail?: string) =>
      app.setJob({ id: step, label: d.label, done, total, status, detail });
    job('running');
    if (!items.length) {
      await kv.del(progressKey);
      job('done');
      return;
    }
    markWork();

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
        await kv.setMany([
          [`tried:${step}`, Array.from(tried)],
          [progressKey, done],
        ]);
        if (sharedKey && triedNew.length) {
          const batch = triedNew;
          triedNew = [];
          await writeTried(sharedKey, batch).catch(() => undefined);
        }
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
        if (ok)
          for (const t of b) {
            tried.add(t.uri);
            triedNew.push(t.uri);
          }
        done += b.length;
        job('running');
        if (pending.length >= 50 || Date.now() - lastFlush > 3000) await flush();
      }
    };

    await Promise.all(Array.from({ length: typeof d.concurrency === 'function' ? d.concurrency() : d.concurrency }, worker));
    await flush(true);
    if (!ctrl.signal.aborted && items.length === pendingAll.length) await kv.del(progressKey);
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
  if ((await kv.get<number>('tried_version')) === 2) return;
  await kv.delMany(['tried:lyrics', 'tried:tags', 'tried:covers']);
  await kv.set('tried_version', 2);
}

/** Copies public catalog hits into this analysis' meta before network steps.
 *  Without this, shared "tried" skips the fetch but leaves meta empty (mood/map lose those songs). */
async function seedFromCatalog(): Promise<void> {
  const missing = await query<{ uri: string }>(`
    SELECT t.uri FROM tracks t LEFT JOIN meta m USING (uri)
    WHERE t.plays > 0 AND t.uri LIKE 'spotify:track:%'
      AND (m.uri IS NULL OR m.cover IS NULL OR m.lyrics IS NULL OR m.tags IS NULL
           OR m.mood_source IS NULL OR m.valence IS NULL)`);
  if (!missing.length) return;
  const cat = await readCatalog(missing.map((r) => r.uri)).catch(() => [] as MetaRow[]);
  if (!cat.length) return;
  const rows: MetaRow[] = [];
  for (const c of cat) {
    const row: MetaRow = { uri: c.uri };
    let useful = false;
    for (const k of ['cover', 'valence', 'energy', 'danceability', 'tempo', 'acousticness', 'mood_source', 'mood_conf', 'lyrics', 'tags'] as const) {
      if (c[k] != null && c[k] !== '') {
        row[k] = c[k];
        useful = true;
      }
    }
    if (useful) rows.push(row);
  }
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 3000) await upsertMeta(rows.slice(i, i + 3000), false);
  await persistMeta();
}

/** Starts every enabled step in parallel (different hosts → no shared rate limit). */
export function runAllEnabled() {
  void migrateTried()
    .then(() => seedFromCatalog())
    .then(runAllEnabledNow)
    .catch((e) => console.warn('avvio attività', e));
}

function runAllEnabledNow() {
  const s = getApp().settings;
  const runs: Array<Promise<void>> = [];
  const covers = s.connections.covers ? runStep('covers') : Promise.resolve();
  if (s.connections.audiofeatures) runs.push(runStep('audiofeatures'));
  // Every track, most-listened first, at the providers' polite rates. Results land in the shared catalog,
  // so only the first analysis that meets a song pays the wait.
  if (s.connections.lyrics) runs.push(runStep('lyrics'));
  if (s.connections.lastfm) runs.push(runStep('tags'));
  // AI mood and the taste map need lyrics/tags (their input) and audio features (anchors): they start ONCE,
  // when all of those are in. Starting earlier meant a partial run, then new candidates and a second run.
  // When everything is in, record the analysis as complete (Confronta waits for it).
  void Promise.all(runs)
    .then(() => Promise.all([autoMoodAi(), autoEmbeddings()]))
    .then(() => covers)
    .then(() => markCompleteIfDone())
    .then((complete) => {
      // A few lookups that keep failing must not stall the queue: the automatic run ended by itself
      // (nothing running, nothing paused by hand, not on hold) → next person. Reopening resumes the rest.
      if (complete || isEnrichmentHeld() || queueActiveId() !== currentAnalysisId()) return;
      const jobs = Object.values(getApp().jobs);
      if (jobs.some((j) => j.status === 'running' || j.status === 'paused')) return;
      return advanceQueue().then(() => undefined);
    })
    .catch((e) => console.warn('completamento analisi', e));
}

export async function resetTried() {
  await kv.delMany((Object.keys(STEPS) as StepId[]).flatMap((s) => [`tried:${s}`, `progress:${s}`]));
  await clearTriedShared();
}

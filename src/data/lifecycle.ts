import { exec, getExcluded, loadPlays, query, setExcluded, setFilter, upsertMeta, type ExcludedTrack } from './db';
import { clearIndexCache } from '../ml/embeddings';
import { parseExport, type ParseResult } from './import';
import { emptyProfile, type AccountProfile } from './account';
import { getApp } from '../lib/store';
import { kv } from '../lib/kv';
import { readCatalog } from '../lib/catalogCache';
import { runAllEnabled } from '../enrichment/jobs';
import { analyses, currentAnalysisId, setCurrentAnalysis } from '../lib/analyses';
import { applyMoodAdjustments } from './moodAdjust';
import { processNext } from '../lib/importQueue';
import { navigate, routes } from '../lib/router';

/** Re-applies cached public metadata (covers, audio features) to the loaded tracks — no network needed. */
async function hydrateFromCatalog() {
  const missing = await query<{ uri: string }>(
    `SELECT t.uri FROM tracks t LEFT JOIN meta m USING (uri)
     WHERE t.uri LIKE 'spotify:track:%' AND (m.cover IS NULL OR m.valence IS NULL OR m.lyrics IS NULL OR m.tags IS NULL)`,
  );
  const cached = await readCatalog(missing.map((m) => m.uri));
  if (cached.length) await upsertMeta(cached);
}

/** Called after an import or a restore: sets bounds, resets the filter and starts opt-in enrichment. */
export async function afterDataLoaded() {
  const b = await query<{ min: string; max: string }>(
    `SELECT min(day)::VARCHAR AS min, max(day)::VARCHAR AS max FROM plays WHERE kind = 'track'`,
  );
  await setFilter(null, null);
  const [profile, dataset] = await Promise.all([
    kv.get<AccountProfile>('profile'),
    kv.get<{ historyKind: 'extended' | 'legacy'; rows: number }>('dataset'),
  ]);
  getApp().set({ bounds: b[0] ?? null, status: 'ready', range: { from: null, to: null }, profile: profile ?? null, dataset: dataset ?? null });
  await syncAnalysisMeta(b[0] ?? null, profile ?? null, dataset ?? null).catch((e) => console.warn('analysis meta', e));
  await hydrateFromCatalog().catch((e) => console.warn('catalog cache', e));
  await applyMoodAdjustments().catch((e) => console.warn('mood adjust', e));
  getApp().bump();
  setTimeout(runAllEnabled, 800);
}

/** Keeps the history list informative (period, size, person) and marks the analysis as just opened. */
async function syncAnalysisMeta(
  bounds: { min: string; max: string } | null,
  profile: AccountProfile | null,
  dataset: { historyKind: 'extended' | 'legacy'; rows: number } | null,
) {
  const id = currentAnalysisId();
  if (!id) return;
  const a = await analyses.update(id, {
    opened: true,
    first_day: bounds?.min ?? null,
    last_day: bounds?.max ?? null,
    history_kind: dataset?.historyKind ?? null,
    rows: dataset?.rows ?? null,
    display_name: profile?.displayName ?? profile?.username ?? null,
  });
  getApp().set({ analysis: a });
}

export async function applyRange(from: string | null, to: string | null) {
  await setFilter(from, to);
  getApp().set({ range: { from, to } });
  getApp().bump();
}

export interface ImportOutcome {
  rows: number;
  ms: number;
  historyKind: 'extended' | 'legacy' | 'none';
  profileFound: boolean;
  /** Set when a last-year history was ignored because the full history is already loaded. */
  keptExisting: boolean;
}

/**
 * Import pipeline.
 * - mode 'replace' (onboarding / "sostituisci"): new person or fresh start → previous profile is dropped.
 * - mode 'merge' (second package): keeps what's there; a last-year history never overwrites a full one.
 */
export async function importFiles(
  files: File[],
  onStep: (s: string) => void,
  opts: { mode?: 'replace' | 'merge'; name?: string; newAnalysis?: boolean } = {},
): Promise<ImportOutcome> {
  const mode = opts.mode ?? 'replace';
  const tz = getApp().settings.timeZone;
  const t0 = performance.now();
  const res = await parseExport(files, tz, onStep);
  if (!opts.newAnalysis) return importInto(res, t0, mode, onStep, opts.name);

  // New saved analysis: the typed name wins, otherwise the name in the "account data" package.
  const title = opts.name?.trim() || res.profile?.displayName?.trim() || res.profile?.username?.trim() || '';
  if (!title) throw new Error('Dai un nome a questa analisi (oppure carica anche lo ZIP “Dati dell’account”: il nome lo prendo da lì).');
  onStep('Creo l’analisi nel database…');
  const created = await analyses.create(title);
  setCurrentAnalysis(created.id);
  try {
    return await importInto(res, t0, mode, onStep);
  } catch (e) {
    await analyses.remove(created.id).catch(() => undefined);
    setCurrentAnalysis(null);
    throw e;
  }
}

async function importInto(
  res: ParseResult,
  t0: number,
  mode: 'replace' | 'merge',
  onStep: (s: string) => void,
  personName?: string,
): Promise<ImportOutcome> {
  const prevDataset = await kv.get<{ historyKind: 'extended' | 'legacy'; rows: number }>('dataset');
  const prevProfile = mode === 'merge' ? await kv.get<AccountProfile>('profile') : undefined;

  // Profile: merge account package fields, then manual name as fallback.
  let profile: AccountProfile | null = res.profile ?? prevProfile ?? null;
  if (res.profile && prevProfile) profile = { ...prevProfile, ...res.profile, displayName: res.profile.displayName ?? prevProfile.displayName };
  if (personName?.trim()) {
    profile = profile ?? emptyProfile();
    if (!profile.displayName) profile.displayName = personName.trim();
  }
  if (profile) await kv.set('profile', profile);
  else await kv.del('profile');

  let keptExisting = false;
  const hasHistory = res.stats.rows > 0 && res.historyKind !== 'none';
  const downgrade = mode === 'merge' && res.historyKind === 'legacy' && prevDataset?.historyKind === 'extended';
  if (hasHistory && !downgrade && mode === 'replace') {
    // New person / fresh start: drop personal derived data (catalog cache is kept and re-applied).
    await kv.delMany(['emb_index', 'clusters', 'bandit_arms', 'bandit_feedback', 'mood_report', 'ask_history', 'era_names', 'meta_rows', 'meta_ipc']);
    await exec('DELETE FROM meta; DELETE FROM clusters;').catch(() => undefined);
    clearIndexCache();
  }
  if (hasHistory && !downgrade) {
    onStep(`Indicizzo ${res.stats.rows.toLocaleString('it-IT')} ascolti…`);
    await loadPlays(res.cols);
    await kv.set('dataset', { historyKind: res.historyKind, rows: res.stats.rows });
    // New listening data: the analysis has to be enriched again before it counts as complete.
    const id = currentAnalysisId();
    if (id) await analyses.update(id, { enriched_at: null }).catch(() => undefined);
  } else {
    keptExisting = downgrade;
    if (!prevDataset && !hasHistory) throw new Error('Questo pacchetto non contiene cronologia di ascolto: carica anche la "Cronologia di streaming estesa".');
  }
  await afterDataLoaded();
  return { rows: res.stats.rows, ms: performance.now() - t0, historyKind: res.historyKind, profileFound: !!res.profile, keptExisting };
}

export async function setProfileName(name: string) {
  const p = (await kv.get<AccountProfile>('profile')) ?? emptyProfile();
  p.displayName = name.trim() || null;
  await kv.set('profile', p);
  getApp().set({ profile: p });
}

async function applyExcluded(list: ExcludedTrack[]) {
  await setExcluded(list);
  const { from, to } = getApp().range;
  await setFilter(from, to);
  const b = await query<{ min: string; max: string }>(`SELECT min(day)::VARCHAR AS min, max(day)::VARCHAR AS max FROM plays WHERE kind = 'track'`);
  getApp().set({ bounds: b[0] ?? null });
  getApp().bump();
}

/** Removes a track from the whole app (every stat, chart, story, report, model). Reversible from Impostazioni. */
export async function excludeTrack(t: ExcludedTrack) {
  const list = await getExcluded();
  if (list.some((e) => e.uri === t.uri)) return;
  await applyExcluded([...list, t]);
}

export async function includeTrack(uri: string) {
  const list = await getExcluded();
  await applyExcluded(list.filter((e) => e.uri !== uri));
}

export async function includeAll() {
  await applyExcluded([]);
}

/**
 * Imports the next queued person into a new analysis (start screen only) and opens it.
 * Returns false when nothing was waiting (or every entry failed: their errors stay in the queue).
 */
export function importNextQueued(): Promise<boolean> {
  return processNext(async (e) => {
    const app = getApp();
    app.set({ status: 'importing', importStep: `Preparazione… (${e.name || e.files[0]?.name || 'in coda'})` });
    const out = await importFiles(e.files, (s) => app.set({ importStep: s }), { mode: 'replace', name: e.name, newAnalysis: true });
    navigate(out.historyKind === 'extended' ? routes.story() : routes.overview());
    return currentAnalysisId();
  });
}

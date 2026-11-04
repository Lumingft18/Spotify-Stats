import { exec, loadPlays, query, setFilter, upsertMeta } from './db';
import { clearIndexCache } from '../ml/embeddings';
import { parseExport } from './import';
import { emptyProfile, type AccountProfile } from './account';
import { getApp } from '../lib/store';
import { idb } from '../lib/idb';
import { readCatalog } from '../lib/catalogCache';
import { runAllEnabled } from '../enrichment/jobs';

/** Re-applies cached public metadata (covers, audio features) to the loaded tracks — no network needed. */
async function hydrateFromCatalog() {
  const missing = await query<{ uri: string }>(
    `SELECT t.uri FROM tracks t LEFT JOIN meta m USING (uri)
     WHERE t.uri LIKE 'spotify:track:%' AND (m.cover IS NULL OR m.valence IS NULL)`,
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
    idb.get<AccountProfile>('profile'),
    idb.get<{ historyKind: 'extended' | 'legacy'; rows: number }>('dataset'),
  ]);
  getApp().set({ bounds: b[0] ?? null, status: 'ready', range: { from: null, to: null }, profile: profile ?? null, dataset: dataset ?? null });
  await hydrateFromCatalog().catch((e) => console.warn('catalog cache', e));
  getApp().bump();
  setTimeout(runAllEnabled, 800);
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
  opts: { mode?: 'replace' | 'merge'; name?: string } = {},
): Promise<ImportOutcome> {
  const mode = opts.mode ?? 'replace';
  const tz = getApp().settings.timeZone;
  const t0 = performance.now();
  const res = await parseExport(files, tz, onStep);
  const prevDataset = await idb.get<{ historyKind: 'extended' | 'legacy'; rows: number }>('dataset');
  const prevProfile = mode === 'merge' ? await idb.get<AccountProfile>('profile') : undefined;

  // Profile: merge account package fields, then manual name as fallback.
  let profile: AccountProfile | null = res.profile ?? prevProfile ?? null;
  if (res.profile && prevProfile) profile = { ...prevProfile, ...res.profile, displayName: res.profile.displayName ?? prevProfile.displayName };
  if (opts.name?.trim()) {
    profile = profile ?? emptyProfile();
    if (!profile.displayName) profile.displayName = opts.name.trim();
  }
  if (profile) await idb.set('profile', profile);
  else await idb.del('profile');

  let keptExisting = false;
  const hasHistory = res.stats.rows > 0 && res.historyKind !== 'none';
  const downgrade = mode === 'merge' && res.historyKind === 'legacy' && prevDataset?.historyKind === 'extended';
  if (hasHistory && !downgrade && mode === 'replace') {
    // New person / fresh start: drop personal derived data (catalog cache is kept and re-applied).
    await Promise.all(
      ['emb_index', 'clusters', 'bandit_arms', 'bandit_feedback', 'mood_report', 'ask_history', 'era_names', 'meta_rows'].map((k) => idb.del(k)),
    );
    await exec('DELETE FROM meta; DELETE FROM clusters;').catch(() => undefined);
    clearIndexCache();
  }
  if (hasHistory && !downgrade) {
    onStep(`Indicizzo ${res.stats.rows.toLocaleString('it-IT')} ascolti…`);
    await loadPlays(res.cols);
    await idb.set('dataset', { historyKind: res.historyKind, rows: res.stats.rows });
  } else {
    keptExisting = downgrade;
    if (!prevDataset && !hasHistory) throw new Error('Questo pacchetto non contiene cronologia di ascolto: carica anche la "Cronologia di streaming estesa".');
  }
  await afterDataLoaded();
  return { rows: res.stats.rows, ms: performance.now() - t0, historyKind: res.historyKind, profileFound: !!res.profile, keptExisting };
}

export async function setProfileName(name: string) {
  const p = (await idb.get<AccountProfile>('profile')) ?? emptyProfile();
  p.displayName = name.trim() || null;
  await idb.set('profile', p);
  getApp().set({ profile: p });
}

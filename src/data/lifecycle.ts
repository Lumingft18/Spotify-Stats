import { loadPlays, query, setFilter } from './db';
import { parseExport } from './import';
import { getApp } from '../lib/store';
import { runAllEnabled } from '../enrichment/jobs';

/** Called after an import or a restore: sets bounds, resets the filter and starts opt-in enrichment. */
export async function afterDataLoaded() {
  const b = await query<{ min: string; max: string }>(
    `SELECT min(day)::VARCHAR AS min, max(day)::VARCHAR AS max FROM plays WHERE kind = 'track'`,
  );
  await setFilter(null, null);
  getApp().set({ bounds: b[0] ?? null, status: 'ready', range: { from: null, to: null } });
  getApp().bump();
  setTimeout(runAllEnabled, 800);
}

export async function applyRange(from: string | null, to: string | null) {
  await setFilter(from, to);
  getApp().set({ range: { from, to } });
  getApp().bump();
}

/** Full import pipeline: parse → DuckDB → persist → derived tables. */
export async function importFiles(files: File[], onStep: (s: string) => void) {
  const tz = getApp().settings.timeZone;
  const t0 = performance.now();
  const { cols, stats } = await parseExport(files, tz, onStep);
  onStep(`Indicizzo ${stats.rows.toLocaleString('it-IT')} ascolti…`);
  await loadPlays(cols);
  await afterDataLoaded();
  return { rows: stats.rows, ms: performance.now() - t0 };
}

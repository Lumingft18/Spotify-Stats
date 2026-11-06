// "Is this analysis complete?" — every enabled enrichment step has nothing (meaningful) left to fetch and
// nothing is running. Recorded on the analysis (enriched_at) so other screens (Confronta) can wait for it.
import { query } from '../data/db';
import { analyses, currentAnalysisId, getCompareReturn, openAnalysis, setCompareReturn } from '../lib/analyses';
import { getApp } from '../lib/store';
import { pendingCount, type StepId } from './jobs';

let workDone = false;
/** Called when a run actually fetched or estimated something (so a saved comparison may be outdated). */
export const markWork = () => {
  workDone = true;
};

const STEP_CONNECTION: Record<StepId, 'covers' | 'audiofeatures' | 'lyrics' | 'lastfm'> = {
  covers: 'covers',
  audiofeatures: 'audiofeatures',
  lyrics: 'lyrics',
  tags: 'lastfm',
};

export async function markCompleteIfDone(): Promise<boolean> {
  const app = getApp();
  const id = currentAnalysisId();
  if (!id) return false;
  if (Object.values(app.jobs).some((j) => j.status === 'running')) return false;
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::INT AS n FROM tracks WHERE plays > 0`);
  // A handful of lookups can keep failing (rate limits, odd titles): ≤ 1% left still counts as complete.
  const tolerance = Math.max(5, Math.round(n * 0.01));
  for (const step of Object.keys(STEP_CONNECTION) as StepId[]) {
    if (!app.settings.connections[STEP_CONNECTION[step]]) continue;
    if ((await pendingCount(step)) > tolerance) return false;
  }
  const a = app.analysis;
  if (!a?.enriched_at || workDone) {
    const updated = await analyses.update(id, { enriched_at: Date.now() });
    app.set({ analysis: updated });
  }
  workDone = false;
  // Completed on behalf of a comparison: go back to it.
  const r = getCompareReturn();
  if (r && r.other === id) {
    setCompareReturn(null);
    openAnalysis(r.back, r.hash);
  }
  return true;
}

// Named analyses saved in the local database. Exactly one is "open" at a time; its id scopes every kv read/write.
import { apiJson } from './api';

export interface Analysis {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  opened_at: number;
  history_kind: 'extended' | 'legacy' | null;
  rows: number | null;
  first_day: string | null;
  last_day: string | null;
  display_name: string | null;
  bytes: number;
}

export type AnalysisPatch = Partial<Pick<Analysis, 'name' | 'history_kind' | 'rows' | 'first_day' | 'last_day' | 'display_name'>> & { opened?: boolean };

const CURRENT_KEY = 'ss2.analysis';

let current: string | null = (() => {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
})();

export const currentAnalysisId = () => current;

/** Remembers which analysis this browser has open (restored on reload). */
export function setCurrentAnalysis(id: string | null) {
  current = id;
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* private mode */
  }
}

export const analyses = {
  list: () => apiJson<Analysis[]>('/analyses'),
  get: (id: string) => apiJson<Analysis>(`/analyses/${encodeURIComponent(id)}`),
  create: (name: string) => apiJson<Analysis>('/analyses', 'POST', { name }),
  update: (id: string, patch: AnalysisPatch) => apiJson<Analysis>(`/analyses/${encodeURIComponent(id)}`, 'PATCH', patch),
  remove: (id: string) => apiJson<{ ok: true }>(`/analyses/${encodeURIComponent(id)}`, 'DELETE'),
};

/** Opens a saved analysis: full reload so DuckDB, jobs and caches start clean. */
export function openAnalysis(id: string) {
  setCurrentAnalysis(id);
  location.hash = '#/';
  location.reload();
}

/** Back to the start screen (new analysis or history), keeping everything saved. */
export function leaveAnalysis() {
  setCurrentAnalysis(null);
  location.hash = '#/';
  location.reload();
}

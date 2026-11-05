// AI mood estimation as a background job: one shared controller so it can be started automatically
// (after the free enrichment steps) and stopped from Attività, the Mood page or Impostazioni.
import { lyricsValenceCandidates, moodCandidates, runLyricsValence, runMoodV2, type MoodRunReport } from '../llm/mood';
import { applyMoodAdjustments } from '../data/moodAdjust';
import { persistMeta } from '../data/db';
import { getApp } from '../lib/store';

export const MOOD_AI_JOB = 'mood_llm';
const LABEL = 'Mood AI';

let ctrl: AbortController | null = null;

export const isMoodAiRunning = () => ctrl !== null;

export function stopMoodAi() {
  ctrl?.abort();
}

export function moodAiAvailable(): boolean {
  const s = getApp().settings;
  return s.connections.llm && !!s.openrouterKey;
}

export async function startMoodAi(opts: { limit: number; samples?: 1 | 2 | 3 }): Promise<MoodRunReport | null> {
  if (ctrl || !moodAiAvailable()) return null;
  const app = getApp();
  const c = new AbortController();
  ctrl = c;
  let done = 0;
  let total = 0;
  let phase = '';
  const job = (status: 'running' | 'done' | 'paused' | 'error', detail?: string) =>
    app.setJob({ id: MOOD_AI_JOB, label: LABEL, done, total, status, detail: detail ?? phase });
  const progress = (d: number, t: number) => {
    done = d;
    total = t;
    job('running');
  };
  try {
    let report: MoodRunReport | null = null;
    // 1) Tracks without audio features: estimate valence + energy from lyrics and tags.
    if ((await moodCandidates(1)).length) {
      phase = 'brani senza audio features: stima da testo e tag';
      report = await runMoodV2({ limit: opts.limit, samples: opts.samples ?? 2, signal: c.signal, onProgress: progress });
    }
    // 2) Tracks with audio features: lyric valence, fused with the audio valence.
    if (!c.signal.aborted && (await lyricsValenceCandidates(1)).length) {
      phase = 'positività dei testi (unita a quella audio)';
      await runLyricsValence({ limit: opts.limit, signal: c.signal, onProgress: progress });
    }
    await applyMoodAdjustments();
    await persistMeta();
    phase = '';
    job(c.signal.aborted ? 'paused' : 'done');
    return report;
  } catch (e) {
    if (c.signal.aborted) job('paused');
    else job('error', e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    ctrl = null;
    getApp().bump();
  }
}

/** Runs only when enabled in Impostazioni, a key is set and some tracks still lack a mood. */
export async function autoMoodAi(): Promise<void> {
  const s = getApp().settings;
  if (!s.autoMoodAi || !moodAiAvailable() || ctrl) return;
  if (!(await moodCandidates(1)).length && !(await lyricsValenceCandidates(1)).length) return;
  await startMoodAi({ limit: s.autoMoodAiLimit }).catch(() => undefined);
}

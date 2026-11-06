// AI mood estimation as a background job: one shared controller so it can be started automatically
// (after the free enrichment steps) and stopped from Attività, the Mood page or Impostazioni.
// Gate: the configured estimator is first benchmarked on held-out measured tracks (llm/moodBench.ts);
// estimates are written only if it beats a constant guess, and earlier estimates are withdrawn if not.
import { lyricsValenceCandidates, moodCandidates, rejectAiEstimates, runLyricsValence, runMoodV2, type MoodRunReport } from '../llm/mood';
import { currentBench, runMoodBench } from '../llm/moodBench';
import { applyMoodAdjustments } from '../data/moodAdjust';
import { exec, persistMeta } from '../data/db';
import { kv } from '../lib/kv';
import { getApp } from '../lib/store';
import { isEnrichmentHeld } from './pause';

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

const lyricsAvailable = moodAiAvailable;

export async function startMoodAi(opts: { limit: number; samples?: 1 | 2 | 3 }): Promise<MoodRunReport | null> {
  if (ctrl || (!moodAiAvailable() && !lyricsAvailable())) return null;
  const app = getApp();
  const c = new AbortController();
  ctrl = c;
  let done = 0;
  let total = 0;
  let phase = '';
  let note = '';
  const job = (status: 'running' | 'done' | 'paused' | 'error', detail?: string) =>
    app.setJob({ id: MOOD_AI_JOB, label: LABEL, done, total, status, detail: detail ?? phase });
  const progress = (d: number, t: number) => {
    done = d;
    total = t;
    job('running');
  };
  try {
    let report: MoodRunReport | null = null;
    // 1) Tracks without audio features: valence + energy from lyrics and tags, only if the estimator passes the benchmark.
    if (moodAiAvailable() && (await moodCandidates(1)).length) {
      let b = await currentBench();
      if (!b) {
        phase = 'verifica dello stimatore su brani misurati (benchmark)';
        await runMoodBench({ signal: c.signal, onProgress: (_l, d, t) => progress(d, t) });
        b = await currentBench();
      }
      if (!c.signal.aborted && b) {
        if (b.result.useful.valence) {
          phase = 'brani senza audio features: stima da testo e tag';
          report = await runMoodV2({ limit: opts.limit, samples: opts.samples ?? 2, bench: b.bench, signal: c.signal, onProgress: progress });
        } else {
          const n = await rejectAiEstimates();
          note = `stimatore non affidabile sul benchmark (r valence ${b.result.valence.r.toFixed(2)}): nessuna stima scritta${n ? `, ${n} stime precedenti ritirate` : ''}`;
        }
      }
    }
    // 2) Tracks with audio features: lyric valence, fused with the audio valence.
    if (!c.signal.aborted && lyricsAvailable() && (await lyricsValenceCandidates(1)).length) {
      phase = 'positività dei testi (unita a quella audio)';
      await runLyricsValence({ limit: opts.limit, signal: c.signal, onProgress: progress });
    }
    await applyMoodAdjustments();
    await persistMeta();
    phase = '';
    job(c.signal.aborted ? 'paused' : 'done', note || undefined);
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

/** Estimates written with an older prompt are queued again (values stay visible until replaced).
 *  v2: the old prompt told the model to stay near the average, which flattened estimates (r ≈ 0.2 vs 0.5 now). */
const PROMPT_VERSION = 2;
async function requeueOldEstimates() {
  if ((await kv.get<number>('mood_prompt_version')) === PROMPT_VERSION) return;
  await exec(`UPDATE meta SET mood_source = 'llm_pending' WHERE mood_source = 'llm'`);
  await persistMeta();
  await kv.set('mood_prompt_version', PROMPT_VERSION);
}

/** Runs only when enabled in Impostazioni, a key is set and some tracks still lack a mood. */
export async function autoMoodAi(): Promise<void> {
  await requeueOldEstimates();
  const s = getApp().settings;
  if (!s.autoMoodAi || (!moodAiAvailable() && !lyricsAvailable()) || ctrl || isEnrichmentHeld()) return;
  const b = await currentBench();
  const moodTodo = moodAiAvailable() && (await moodCandidates(1)).length > 0 && (!b || b.result.useful.valence);
  if (!moodTodo && !(lyricsAvailable() && (await lyricsValenceCandidates(1)).length)) return;
  await startMoodAi({ limit: s.autoMoodAiLimit }).catch(() => undefined);
}

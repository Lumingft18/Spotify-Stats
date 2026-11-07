// While enrichment jobs run: Screen Wake Lock (browser) + server caffeinate on AC power.
// On wake / tab visible again: restart steps that ended in error or pause (sleep can kill fetches).
import { apiJson } from '../lib/api';
import { getApp } from '../lib/store';
import { runStep, STEPS, type StepId, isRunning } from './jobs';
import { MOOD_AI_JOB, startMoodAi, isMoodAiRunning } from './moodAi';
import { EMBED_JOB, startEmbeddings, isEmbeddingRunning } from './embedAi';

let wakeLock: WakeLockSentinel | null = null;
let serverHold = false;
let wired = false;

function anyRunning(): boolean {
  return Object.values(getApp().jobs).some((j) => j.status === 'running');
}

async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
      if (anyRunning() && document.visibilityState === 'visible') void requestWakeLock();
    });
  } catch {
    /* unsupported / denied / hidden tab */
  }
}

async function setServerHold(on: boolean) {
  if (on === serverHold) return;
  try {
    await apiJson('/awake', 'POST', { hold: on });
    serverHold = on;
  } catch {
    if (!on) serverHold = false;
    // hold:true failed → leave false so the next sync retries
  }
}

/** Call whenever job status changes (from store.setJob). */
export async function syncKeepAwake(): Promise<void> {
  ensureWired();
  const on = anyRunning();
  if (on) {
    await requestWakeLock();
    await setServerHold(true);
  } else {
    try {
      await wakeLock?.release();
    } catch {
      /* ignore */
    }
    wakeLock = null;
    await setServerHold(false);
  }
}

function resumeAfterWake() {
  const app = getApp();
  if (app.status !== 'ready' || !app.analysis) return;
  for (const id of Object.keys(STEPS) as StepId[]) {
    const j = app.jobs[id];
    if (!j) continue;
    if ((j.status === 'error' || j.status === 'paused') && !isRunning(id)) void runStep(id);
  }
  const mood = app.jobs[MOOD_AI_JOB];
  if (mood && (mood.status === 'error' || mood.status === 'paused') && !isMoodAiRunning() && app.settings.autoMoodAi) {
    void startMoodAi({ limit: app.settings.autoMoodAiLimit }).catch(() => undefined);
  }
  const emb = app.jobs[EMBED_JOB];
  if (emb && (emb.status === 'error' || emb.status === 'paused') && !isEmbeddingRunning() && app.settings.autoEmbeddings) {
    void startEmbeddings(app.settings.autoEmbeddingsLimit);
  }
  void syncKeepAwake();
}

function ensureWired() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAfterWake();
  });
  window.addEventListener('online', () => resumeAfterWake());
  // Some browsers fire this after sleep/wake.
  window.addEventListener('focus', () => {
    if (anyRunning()) void requestWakeLock();
  });
}

export type AwakeInfo = { wanted: boolean; holding: boolean; onAC: boolean; supported: boolean };

export async function fetchAwakeStatus(): Promise<AwakeInfo | null> {
  try {
    return await apiJson<AwakeInfo>('/awake');
  } catch {
    return null;
  }
}

// Levanto Sage (decision model): typed "scale" decisions with a probability per level, instead of free text.
// Used as an alternative mood estimator; whether it is any good is decided by the mood benchmark, not assumed.
// API: https://docs.levanto.ai (POST /decide/batch, Bearer key, CORS open).
import { getApp, useApp } from '../lib/store';

const ENDPOINT = 'https://sage.levanto.ai/decide/batch';

export function sageAvailable(): boolean {
  const s = getApp().settings;
  return s.connections.sage && !!s.sageKey;
}

export function useSageAvailable(): boolean {
  return useApp((s) => s.settings.connections.sage && !!s.settings.sageKey);
}

interface ScaleResult {
  expectation: number;
  confidence: number;
  probabilities: Array<{ level: number; probability: number }>;
}

interface BatchResponse {
  results: Array<{ answers: Array<{ ok: boolean; result?: { id: string; result: ScaleResult | null }; error?: string }> }>;
}

const levels = (lo: string, mid: string, hi: string) =>
  Array.from({ length: 11 }, (_, i) => ({
    level: i,
    description: i === 0 ? lo : i === 5 ? mid : i === 10 ? hi : `${i}/10`,
  }));

const VALENCE_LEVELS = levels('cupo, disperato, triste o rabbioso', 'neutro o ambivalente', 'gioioso, euforico, sereno');
const ENERGY_LEVELS = levels('calmissimo, acustico, lento, sussurrato', 'moderato', 'intensissimo, veloce, forte, distorto');

export interface SageMood {
  valence: number | null;
  energy: number | null;
  /** Sage's own confidence, mean of the two decisions (0–1). */
  confidence: number;
}

/**
 * Scores valence and energy (0–1) for each content string. `reference` (optional) is a list of measured
 * examples prepended to the instructions so the scale matches the audio-feature scale.
 */
export async function sageMoodBatch(contents: string[], reference: string, signal?: AbortSignal): Promise<SageMood[]> {
  const { sageKey } = getApp().settings;
  if (!sageAvailable()) throw new Error('Sage non è attivo: inserisci la chiave Levanto in Impostazioni.');
  getApp().logNet('sage.levanto.ai', 'decisioni (mood)');
  const ref = reference ? `\nEsempi misurati sull'audio (scala 0–1, moltiplica per 10):\n${reference}` : '';
  const body = {
    reasoning: 'off',
    requests: contents.map((content) => ({
      content,
      questions: [
        {
          id: 'valence',
          kind: 'scale',
          instructions: `Quanto è emotivamente positivo questo brano (valence, come le audio features di Spotify)? Considera soprattutto testo e tono.${ref}`,
          levels: VALENCE_LEVELS,
        },
        {
          id: 'energy',
          kind: 'scale',
          instructions: `Quanto è intenso/energico questo brano (energy, come le audio features di Spotify)? Considera soprattutto generi, tag e stile.${ref}`,
          levels: ENERGY_LEVELS,
        },
      ],
    })),
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sageKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Sage ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as BatchResponse;
  return j.results.map((r) => {
    const get = (id: string) => r.answers.find((a) => a.ok && a.result?.id === id)?.result?.result ?? null;
    const v = get('valence');
    const e = get('energy');
    const conf = [v?.confidence, e?.confidence].filter((x): x is number => typeof x === 'number');
    return {
      valence: v ? Math.min(1, Math.max(0, v.expectation / 10)) : null,
      energy: e ? Math.min(1, Math.max(0, e.expectation / 10)) : null,
      confidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0,
    };
  });
}

/** Checks the key on the token-estimate endpoint (no decision is charged). */
export async function checkSageKey(key: string): Promise<boolean> {
  const res = await fetch('https://sage.levanto.ai/usage/estimate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'ok', question: { id: 'x', kind: 'yesno', instructions: 'ok?' } }),
  });
  return res.status !== 401 && res.status !== 403;
}

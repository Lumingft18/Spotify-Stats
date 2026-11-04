// Mood v2: valence/energy from lyrics + tags with few-shot anchors (measured values), self-consistency confidence
// and a hold-out calibration against tracks whose audio features are known.
import { query, upsertMeta } from '../data/db';
import type { MetaRow } from '../data/schema';
import { idb } from '../lib/idb';
import { getApp } from '../lib/store';
import { structured } from './client';

interface Item {
  uri: string;
  track: string;
  artist: string;
  tags: string | null;
  lyrics: string | null;
  valence?: number;
  energy?: number;
}

export interface MoodRunReport {
  analyzed: number;
  anchors: number;
  calibration: { n: number; maeValence: number; maeEnergy: number; rValence: number; rEnergy: number } | null;
  at: number;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'valence', 'energy', 'evidence'],
        properties: {
          id: { type: 'string' },
          valence: { type: 'number', minimum: 0, maximum: 1 },
          energy: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `Sei un esperto di Music Emotion Recognition. Per ogni brano stimi due valori continui da 0 a 1:
- valence: positività emotiva percepita (0 = cupo/triste/rabbioso, 1 = gioioso/euforico/sereno). Usa soprattutto il TESTO e il tono.
- energy: intensità/arousal percepita (0 = calmo, acustico, lento; 1 = intenso, veloce, forte). Usa soprattutto GENERI/TAG e lo stile dell'artista.
Calibra le stime sui BRANI DI RIFERIMENTO forniti: i loro valori sono misurati sull'audio e definiscono la scala.
Se le informazioni sono scarse, resta vicino a 0.5 invece di inventare. "evidence" = max 12 parole sul perché.
Rispondi solo con il JSON richiesto, con un elemento per ogni id ricevuto.`;

const clip = (s: string | null, n: number) => (s ? s.replace(/\s+/g, ' ').slice(0, n) : '');

function describe(i: Item, withLyrics = 380) {
  const bits = [`"${i.track}" — ${i.artist}`];
  if (i.tags) bits.push(`tag: ${i.tags}`);
  if (i.lyrics === '[strumentale]') bits.push('strumentale');
  else if (i.lyrics) bits.push(`testo: ${clip(i.lyrics, withLyrics)}`);
  return bits.join(' | ');
}

function pickAnchors(pool: Item[], n: number): Item[] {
  // Stratify on the 4 quadrants, prefer anchors with textual signal.
  const q = (i: Item) => (i.valence! > 0.5 ? 1 : 0) + (i.energy! > 0.5 ? 2 : 0);
  const buckets: Item[][] = [[], [], [], []];
  for (const i of [...pool].sort((a, b) => Number(!!b.lyrics || !!b.tags) - Number(!!a.lyrics || !!a.tags))) buckets[q(i)].push(i);
  const out: Item[] = [];
  let k = 0;
  while (out.length < n && buckets.some((b) => b.length)) {
    const b = buckets[k++ % 4];
    if (b.length) out.push(b.shift()!);
  }
  return out;
}

function pearson(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

export async function moodCandidates(limit: number) {
  return query<Item>(
    `SELECT t.uri, t.track, t.artist, m.tags, m.lyrics FROM tracks t LEFT JOIN meta m USING (uri)
     WHERE (m.mood_source IS NULL OR m.mood_source = 'llm_pending') AND t.plays > 0
       AND ((m.lyrics IS NOT NULL AND m.lyrics <> '') OR (m.tags IS NOT NULL AND m.tags <> ''))
     ORDER BY t.minutes DESC LIMIT ${Math.floor(limit)}`,
  );
}

export async function runMoodV2(opts: {
  limit: number;
  samples: 1 | 2 | 3;
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
}): Promise<MoodRunReport> {
  const model = getApp().settings.llmModelBulk;
  const known = await query<Item>(
    `SELECT t.uri, t.track, t.artist, m.tags, m.lyrics, m.valence, m.energy FROM tracks t JOIN meta m USING (uri)
     WHERE m.mood_source = 'reccobeats' AND m.valence IS NOT NULL AND m.energy IS NOT NULL ORDER BY t.minutes DESC LIMIT 400`,
  );
  // Hold-out: 12 known tracks are predicted blind to measure accuracy.
  const holdout = known.filter((k) => k.lyrics || k.tags).slice(0, 12);
  const holdSet = new Set(holdout.map((h) => h.uri));
  const anchors = pickAnchors(
    known.filter((k) => !holdSet.has(k.uri)),
    40,
  );
  const anchorText = anchors.length
    ? anchors.map((a) => `- ${describe(a, 160)} ⇒ valence ${a.valence!.toFixed(2)}, energy ${a.energy!.toFixed(2)}`).join('\n')
    : '(nessun riferimento misurato disponibile: usa la tua conoscenza e resta prudente)';

  const targets = [...holdout, ...(await moodCandidates(opts.limit))];
  const B = 12;
  const preds = new Map<string, { v: number[]; e: number[] }>();
  let done = 0;
  const total = targets.length;
  opts.onProgress(0, total);

  const batches: Item[][] = [];
  for (let i = 0; i < targets.length; i += B) batches.push(targets.slice(i, i + B));

  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length && !opts.signal.aborted) {
      const batch = batches[cursor++];
      const ids = new Map(batch.map((t, i) => [`t${i}`, t]));
      const user = `BRANI DI RIFERIMENTO (valori misurati):\n${anchorText}\n\nBRANI DA STIMARE:\n${batch
        .map((t, i) => `[t${i}] ${describe(t)}`)
        .join('\n')}`;
      for (let s = 0; s < opts.samples; s++) {
        try {
          const r = await structured<{ results: Array<{ id: string; valence: number; energy: number }> }>({
            model,
            system: SYSTEM,
            user,
            schemaName: 'mood_estimates',
            schema: SCHEMA,
            temperature: opts.samples > 1 ? 0.7 : 0.2,
            signal: opts.signal,
          });
          for (const x of r.results ?? []) {
            const t = ids.get(x.id);
            if (!t) continue;
            const p = preds.get(t.uri) ?? { v: [], e: [] };
            p.v.push(Math.min(1, Math.max(0, Number(x.valence))));
            p.e.push(Math.min(1, Math.max(0, Number(x.energy))));
            preds.set(t.uri, p);
          }
        } catch (e) {
          if (opts.signal.aborted) return;
          console.warn('mood batch failed', e);
        }
      }
      done += batch.length;
      opts.onProgress(done, total);
      // Persist progressively (non-holdout only).
      const rows: MetaRow[] = [];
      for (const t of batch) {
        if (holdSet.has(t.uri)) continue;
        const p = preds.get(t.uri);
        if (!p?.v.length) continue;
        const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        const spread = p.v.length > 1 ? (Math.max(...p.v) - Math.min(...p.v) + Math.max(...p.e) - Math.min(...p.e)) / 2 : 0.25;
        rows.push({ uri: t.uri, valence: mean(p.v), energy: mean(p.e), mood_source: 'llm', mood_conf: Math.max(0, 1 - spread * 2) });
      }
      if (rows.length) await upsertMeta(rows);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  let calibration: MoodRunReport['calibration'] = null;
  const hv = holdout.filter((h) => preds.get(h.uri)?.v.length);
  if (hv.length >= 6) {
    const pv = hv.map((h) => preds.get(h.uri)!.v.reduce((a, b) => a + b, 0) / preds.get(h.uri)!.v.length);
    const pe = hv.map((h) => preds.get(h.uri)!.e.reduce((a, b) => a + b, 0) / preds.get(h.uri)!.e.length);
    const tv = hv.map((h) => h.valence!);
    const te = hv.map((h) => h.energy!);
    calibration = {
      n: hv.length,
      maeValence: pv.reduce((s, v, i) => s + Math.abs(v - tv[i]), 0) / hv.length,
      maeEnergy: pe.reduce((s, v, i) => s + Math.abs(v - te[i]), 0) / hv.length,
      rValence: pearson(pv, tv),
      rEnergy: pearson(pe, te),
    };
  }
  const report: MoodRunReport = { analyzed: Math.max(0, done - holdout.length), anchors: anchors.length, calibration, at: Date.now() };
  await idb.set('mood_report', report);
  getApp().bump();
  return report;
}

// Mood estimate from the artist: a track without audio features gets the (shrunk) mean of the measured
// tracks by the same artist. Free, no network, and on real libraries it often beats the AI estimate
// (an artist's sound is consistent; titles and lyrics say less than one would hope).
//
// Gate, same rule as the AI estimator (llm/moodBench.ts): benchmark first, write only what beats a constant.
//  - Benchmark: leave-one-out over measured tracks whose artist has ≥ MIN other measured tracks. Each track is
//    predicted from the others by the same artist, never from itself. Baseline: the global mean (a constant).
//  - Prediction: (sum of the artist's other values + K·global mean) / (count + K) — few tracks → close to the mean.
//  - Written with mood_source = 'artist' (an estimate, never shown as a measurement), mood_conf = skill · n/(n+K).
//  - Audio features fetched later (or found in the shared catalog) replace it.
import { persistMeta, query, upsertMeta } from './db';
import type { MetaRow } from './schema';
import { kv } from '../lib/kv';
import { getApp } from '../lib/store';
import { dimMetric, isUseful, type DimMetric } from '../llm/moodBench';
import { mae, mean } from '../ml/stats';

/** Shrinkage toward the global mean, in "virtual tracks". */
export const ARTIST_K = 3;
/** Measured tracks by the same artist needed for an estimate (and for a benchmark item: others, excluding itself). */
export const ARTIST_MIN = 3;

export interface ArtistMoodBench {
  at: number;
  /** Measured tracks used as ground truth. */
  n: number;
  baseline: { valence: number; energy: number; maeValence: number; maeEnergy: number };
  valence: DimMetric;
  energy: DimMetric;
  useful: { valence: boolean; energy: boolean };
}

const KEY = 'mood_artist_bench';
export const loadArtistBench = () => kv.get<ArtistMoodBench>(KEY);

/** Measured raw values (before lyric fusion), like the AI benchmark's ground truth. */
const MEASURED_SQL = `
  SELECT t.artist, coalesce(m.valence_audio, m.valence) AS v, coalesce(m.energy_audio, m.energy) AS e
  FROM tracks t JOIN meta m USING (uri)
  WHERE m.mood_source = 'reccobeats' AND m.valence IS NOT NULL AND m.energy IS NOT NULL`;

export async function runArtistBench(): Promise<ArtistMoodBench | null> {
  const rows = await query<{ artist: string; v: number; e: number }>(MEASURED_SQL);
  if (rows.length < 30) return null;
  const gv = mean(rows.map((r) => r.v));
  const ge = mean(rows.map((r) => r.e));
  const by = new Map<string, { sv: number; se: number; n: number }>();
  for (const r of rows) {
    const a = by.get(r.artist) ?? { sv: 0, se: 0, n: 0 };
    a.sv += r.v;
    a.se += r.e;
    a.n += 1;
    by.set(r.artist, a);
  }
  const pv: number[] = [];
  const pe: number[] = [];
  const tv: number[] = [];
  const te: number[] = [];
  for (const r of rows) {
    const a = by.get(r.artist)!;
    const k = a.n - 1; // the others
    if (k < ARTIST_MIN) continue;
    pv.push((a.sv - r.v + ARTIST_K * gv) / (k + ARTIST_K));
    pe.push((a.se - r.e + ARTIST_K * ge) / (k + ARTIST_K));
    tv.push(r.v);
    te.push(r.e);
  }
  if (pv.length < 30) return null;
  const baseline = { valence: gv, energy: ge, maeValence: mae(tv.map(() => gv), tv), maeEnergy: mae(te.map(() => ge), te) };
  const valence = dimMetric(pv, tv, gv, 21);
  const energy = dimMetric(pe, te, ge, 31);
  const bench: ArtistMoodBench = {
    at: Date.now(),
    n: pv.length,
    baseline,
    valence,
    energy,
    useful: { valence: isUseful(valence, baseline.maeValence), energy: isUseful(energy, baseline.maeEnergy) },
  };
  await kv.set(KEY, bench);
  return bench;
}

/** Withdraws artist estimates (they're recomputed from the current measurements, or dropped if the gate fails). */
export async function clearArtistEstimates(): Promise<void> {
  const rows = await query<{ uri: string }>(`SELECT uri FROM meta WHERE mood_source = 'artist'`);
  if (rows.length) await upsertMeta(rows.map((r) => ({ uri: r.uri, valence: null, energy: null, mood_conf: null, mood_source: null })), false);
}

/**
 * Re-benchmarks, then fills tracks still without a mood (no audio features, no accepted AI estimate)
 * from their artist. Returns how many tracks got an estimate.
 */
export async function applyArtistMood(): Promise<number> {
  const b = await runArtistBench();
  await clearArtistEstimates();
  if (!b?.useful.valence) {
    await persistMeta();
    return 0;
  }
  const skill = Math.max(0, Math.min(1, b.valence.skill));
  const est = await query<{ uri: string; v: number; e: number; n: number }>(`
    WITH meas AS (${MEASURED_SQL}),
    g AS (SELECT avg(v) AS gv, avg(e) AS ge FROM meas),
    a AS (SELECT artist, sum(v) AS sv, sum(e) AS se, count(*) AS n FROM meas GROUP BY artist HAVING count(*) >= ${ARTIST_MIN})
    SELECT t.uri, (a.sv + ${ARTIST_K} * g.gv) / (a.n + ${ARTIST_K}) AS v, (a.se + ${ARTIST_K} * g.ge) / (a.n + ${ARTIST_K}) AS e, a.n::INT AS n
    FROM tracks t JOIN a USING (artist) CROSS JOIN g LEFT JOIN meta m USING (uri)
    WHERE t.plays > 0 AND (m.uri IS NULL OR m.mood_source IS NULL OR m.mood_source IN ('llm_pending', 'llm_rejected'))`);
  const rows: MetaRow[] = est.map((r) => ({
    uri: r.uri,
    valence: r.v,
    energy: b.useful.energy ? r.e : null,
    mood_source: 'artist',
    mood_conf: skill * (r.n / (r.n + ARTIST_K)),
  }));
  for (let i = 0; i < rows.length; i += 3000) await upsertMeta(rows.slice(i, i + 3000), false);
  await persistMeta();
  getApp().bump();
  return rows.length;
}

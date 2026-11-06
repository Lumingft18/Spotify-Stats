// Mood benchmark: does an AI estimator recover measured valence/energy better than a constant guess?
//
// Design (kept deliberately simple and strict):
//  - Ground truth: tracks with measured audio features (ReccoBeats), raw values (before lyric fusion).
//  - Artist-disjoint split: ~30% of artists (hash of the name, fixed seed) are test-only, so the estimator
//    never sees an anchor by the same artist as the track it scores.
//  - Up to N test tracks (default 300), sampled with a fixed seed among those with lyrics or tags.
//  - Baseline: the training mean (a constant). Metrics: MAE, Pearson r, both with 95% bootstrap CI,
//    and skill = 1 − MAE/MAE_baseline.
//  - Verdict "useful" for a dimension only if the MAE CI is entirely below the baseline MAE AND the
//    r CI is entirely above 0. Otherwise estimates for that dimension are not written.
import { kv } from '../lib/kv';
import { getApp } from '../lib/store';
import { bootstrapCI, mae, mean, pearson, rng, shuffleInPlace } from '../ml/stats';
import { estimateMood, measuredTracks, pickAnchors, type Item } from './mood';

export interface DimMetric {
  mae: number;
  maeCI: [number, number];
  r: number;
  rCI: [number, number];
  /** 1 − MAE / baseline MAE (0 = no better than a constant, 1 = perfect). */
  skill: number;
  n: number;
}

export interface ProviderBench {
  /** OpenRouter model id: a new model needs a new benchmark. */
  model: string;
  valence: DimMetric;
  energy: DimMetric;
  useful: { valence: boolean; energy: boolean };
  /** Correlation between the model's own confidence (self-consistency) and −|error|: is its confidence informative? */
  confidenceValidity: number;
}

export interface MoodBench {
  at: number;
  seed: number;
  nTest: number;
  nTrainArtists: number;
  nTestArtists: number;
  baseline: { valence: number; energy: number; maeValence: number; maeEnergy: number };
  providers: ProviderBench[];
}

const BENCH_KEY = 'mood_bench';

export const loadMoodBench = () => kv.get<MoodBench>(BENCH_KEY);


/** The stored result for the configured model, if any. */
export async function currentBench(): Promise<{ bench: MoodBench; result: ProviderBench } | null> {
  const bench = await loadMoodBench();
  const result = bench?.providers.find((p) => p.model === getApp().settings.llmModelBulk);
  return bench && result ? { bench, result } : null;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic artist-disjoint split. */
export function splitByArtist<T extends { artist: string }>(rows: T[], testShare = 0.3, seed = 1) {
  const isTest = (a: string) => (hash(`${seed}|${a.toLowerCase()}`) % 1000) / 1000 < testShare;
  return { train: rows.filter((r) => !isTest(r.artist)), test: rows.filter((r) => isTest(r.artist)) };
}

export function dimMetric(pred: number[], truth: number[], baselineValue: number, seed: number): DimMetric {
  const n = pred.length;
  const m = mae(pred, truth);
  const base = mae(truth.map(() => baselineValue), truth);
  return {
    mae: m,
    maeCI: bootstrapCI(n, (ix) => mae(ix.map((i) => pred[i]), ix.map((i) => truth[i])), { seed }),
    r: pearson(pred, truth),
    rCI: bootstrapCI(n, (ix) => pearson(ix.map((i) => pred[i]), ix.map((i) => truth[i])), { seed: seed + 1 }),
    skill: 1 - m / base,
    n,
  };
}

export const isUseful = (d: DimMetric, baselineMae: number) => d.n >= 30 && d.maeCI[1] < baselineMae && d.rCI[0] > 0;

export async function runMoodBench(opts: {
  n?: number;
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (label: string, done: number, total: number) => void;
}): Promise<MoodBench> {
  const seed = opts.seed ?? 1;
  const measured = await measuredTracks(20000);
  const { train, test } = splitByArtist(measured, 0.3, seed);
  const pool = test.filter((t) => t.lyrics || t.tags);
  const sample = shuffleInPlace([...pool], rng(seed)).slice(0, opts.n ?? 300);
  if (sample.length < 30) throw new Error(`Troppi pochi brani misurati con testo o tag per un benchmark (${sample.length}).`);
  const anchors = pickAnchors(train, 40);
  const bv = mean(train.map((t) => t.valence!));
  const be = mean(train.map((t) => t.energy!));
  const truthV = sample.map((t) => t.valence!);
  const truthE = sample.map((t) => t.energy!);
  const baseline = { valence: bv, energy: be, maeValence: mae(truthV.map(() => bv), truthV), maeEnergy: mae(truthE.map(() => be), truthE) };

  const providers: ProviderBench[] = [];
  const model = getApp().settings.llmModelBulk;
  // Cached only under 'mood_bench': the split is a fixed hash of the artist name, so a cached benchmark estimate
  // was always made without anchors by the same artist — reusing it keeps the verdict honest and costs nothing.
  const est = await estimateMood(sample as Item[], anchors, {
    samples: 1,
    signal: opts.signal,
    onProgress: (d, t) => opts.onProgress?.(model, d, t),
    cacheKind: 'mood_bench',
  });
  const got = sample.filter((t) => {
    const e = est.get(t.uri);
    return e && e.valence != null && e.energy != null;
  });
  if (got.length >= 30) {
    const pv = got.map((t) => est.get(t.uri)!.valence!);
    const pe = got.map((t) => est.get(t.uri)!.energy!);
    const tv = got.map((t) => t.valence!);
    const te = got.map((t) => t.energy!);
    const valence = dimMetric(pv, tv, bv, seed);
    const energy = dimMetric(pe, te, be, seed + 10);
    const conf = got.map((t) => est.get(t.uri)!.agreement);
    const negErr = got.map((_, i) => -(Math.abs(pv[i] - tv[i]) + Math.abs(pe[i] - te[i])));
    providers.push({
      model,
      valence,
      energy,
      useful: { valence: isUseful(valence, baseline.maeValence), energy: isUseful(energy, baseline.maeEnergy) },
      confidenceValidity: pearson(conf, negErr),
    });
  }
  const prev = await loadMoodBench();
  // Results for other models are kept only if they used the same split and test size.
  const kept = prev && prev.seed === seed && prev.nTest === sample.length ? prev.providers.filter((p) => p.model !== model) : [];
  const bench: MoodBench = {
    at: Date.now(),
    seed,
    nTest: sample.length,
    nTrainArtists: new Set(train.map((t) => t.artist)).size,
    nTestArtists: new Set(test.map((t) => t.artist)).size,
    baseline,
    providers: [...providers, ...kept],
  };
  if (!opts.signal?.aborted) await kv.set(BENCH_KEY, bench);
  return bench;
}

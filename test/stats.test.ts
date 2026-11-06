import { describe, expect, it, vi } from 'vitest';
import { auc, bootstrapCI, mae, pearson, quantile, rng, shuffleInPlace } from '../src/ml/stats';

vi.mock('../src/data/db', () => ({ query: async () => [], upsertMeta: async () => undefined }));
vi.mock('../src/lib/idb', () => ({ idb: { get: async () => undefined, set: async () => undefined } }));

describe('stats', () => {
  it('auc handles ties with average ranks', () => {
    expect(auc([0.5, 0.5], [0, 1])).toBeCloseTo(0.5);
    expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBeCloseTo(0.75);
  });
  it('seeded rng and Fisher–Yates are reproducible and unbiased-ish', () => {
    const a = shuffleInPlace([1, 2, 3, 4, 5], rng(3));
    const b = shuffleInPlace([1, 2, 3, 4, 5], rng(3));
    expect(a).toEqual(b);
    const counts = [0, 0, 0];
    const r = rng(9);
    for (let i = 0; i < 30000; i++) counts[shuffleInPlace([0, 1, 2], r)[0]]++;
    for (const c of counts) expect(c / 30000).toBeGreaterThan(0.31);
  });
  it('bootstrap CI contains the statistic', () => {
    const x = Array.from({ length: 200 }, (_, i) => i % 10);
    const [lo, hi] = bootstrapCI(x.length, (ix) => ix.reduce((s, i) => s + x[i], 0) / ix.length, { seed: 2 });
    expect(lo).toBeLessThan(4.5);
    expect(hi).toBeGreaterThan(4.5);
  });
  it('basic metrics', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(mae([1, 2], [2, 4])).toBeCloseTo(1.5);
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
  });
});

describe('mood benchmark helpers', () => {
  it('artist split is disjoint and deterministic; usefulness needs both CIs', async () => {
    const { splitByArtist, isUseful } = await import('../src/llm/moodBench');
    const rows = Array.from({ length: 500 }, (_, i) => ({ artist: `a${i % 80}` }));
    const s1 = splitByArtist(rows, 0.3, 1);
    const s2 = splitByArtist(rows, 0.3, 1);
    expect(s1.test.length).toBe(s2.test.length);
    const ta = new Set(s1.test.map((r) => r.artist));
    expect(s1.train.some((r) => ta.has(r.artist))).toBe(false);
    const d = { mae: 0.15, maeCI: [0.13, 0.17] as [number, number], r: 0.4, rCI: [0.2, 0.5] as [number, number], skill: 0.2, n: 300 };
    expect(isUseful(d, 0.2)).toBe(true);
    expect(isUseful({ ...d, maeCI: [0.13, 0.21] }, 0.2)).toBe(false);
    expect(isUseful({ ...d, rCI: [-0.05, 0.3] }, 0.2)).toBe(false);
  });
});


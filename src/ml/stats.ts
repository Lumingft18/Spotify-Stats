// Small, dependency-free statistics helpers shared by the models and the evaluation code.
// Everything that uses randomness takes a seeded generator so results are reproducible.

export type Rng = () => number;

/** Mulberry32: tiny seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unbiased in-place Fisher–Yates shuffle. */
export function shuffleInPlace<T>(a: T[], r: Rng = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const mean = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : NaN;
};

export function sd(a: ArrayLike<number>) {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : 0;
}

export function pearson(a: number[], b: number[]) {
  const n = a.length;
  if (n < 3) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

export const mae = (pred: number[], truth: number[]) => mean(pred.map((p, i) => Math.abs(p - truth[i])));

/** Percentile of a sorted copy (linear interpolation). */
export function quantile(a: number[], q: number) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}

/** Percentile bootstrap CI of `stat` over resampled row indices. */
export function bootstrapCI(n: number, stat: (idx: number[]) => number, opts: { reps?: number; seed?: number; level?: number } = {}): [number, number] {
  const reps = opts.reps ?? 200;
  const level = opts.level ?? 0.95;
  const r = rng(opts.seed ?? 1);
  const vals: number[] = [];
  const idx = new Array<number>(n);
  for (let b = 0; b < reps; b++) {
    for (let i = 0; i < n; i++) idx[i] = Math.floor(r() * n);
    vals.push(stat(idx));
  }
  return [quantile(vals, (1 - level) / 2), quantile(vals, 1 - (1 - level) / 2)];
}

/** Area under the ROC curve (Mann–Whitney), ties get the average rank. */
export function auc(scores: ArrayLike<number>, labels: ArrayLike<number>): number {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let pos = 0;
  let rankSum = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[idx[k]]) {
      pos++;
      rankSum += avgRank;
    }
    i = j + 1;
  }
  const neg = n - pos;
  if (!pos || !neg) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/// <reference lib="webworker" />
// ML worker: UMAP layout and k-means clustering (CPU-heavy, kept off the main thread).
import { UMAP } from 'umap-js';

export type MlRequest =
  | { type: 'umap'; id: number; vecs: Float32Array; n: number; dim: number; seed: number }
  | { type: 'kmeans'; id: number; vecs: Float32Array; n: number; dim: number; kMin: number; kMax: number; seed: number };

export type MlResponse =
  | { type: 'progress'; stage: string; loaded?: number; total?: number }
  | { type: 'umap'; id: number; xy: Float32Array }
  | { type: 'kmeans'; id: number; labels: Int32Array<ArrayBufferLike>; k: number; silhouette: number }
  | { type: 'error'; id?: number; message: string };

const post = (m: MlResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rows(vecs: Float32Array, n: number, dim: number): number[][] {
  const r: number[][] = new Array(n);
  for (let i = 0; i < n; i++) r[i] = Array.from(vecs.subarray(i * dim, (i + 1) * dim));
  return r;
}

async function umap(id: number, vecs: Float32Array, n: number, dim: number, seed: number) {
  const data = rows(vecs, n, dim);
  const u = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, Math.max(2, n - 1)),
    minDist: 0.08,
    spread: 1.2,
    random: mulberry32(seed),
    distanceFn: (a: number[], b: number[]) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += a[i] * b[i];
      return 1 - d;
    },
  });
  const epochs = u.initializeFit(data);
  for (let e = 0; e < epochs; e++) {
    u.step();
    if (e % 25 === 0) post({ type: 'progress', stage: 'Calcolo mappa', loaded: e, total: epochs });
  }
  const emb = u.getEmbedding();
  const xy = new Float32Array(n * 2);
  emb.forEach((p, i) => {
    xy[i * 2] = p[0];
    xy[i * 2 + 1] = p[1];
  });
  post({ type: 'umap', id, xy }, [xy.buffer]);
}

function kmeansOnce(data: number[][], k: number, rnd: () => number, iters = 40): { labels: Int32Array; centers: number[][] } {
  const n = data.length;
  const dim = data[0].length;
  const dist = (a: number[], b: number[]) => {
    let s = 0;
    for (let i = 0; i < dim; i++) s += (a[i] - b[i]) ** 2;
    return s;
  };
  // k-means++ init
  const centers: number[][] = [data[Math.floor(rnd() * n)].slice()];
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < k) {
    let sum = 0;
    const c = centers[centers.length - 1];
    for (let i = 0; i < n; i++) {
      d2[i] = Math.min(d2[i], dist(data[i], c));
      sum += d2[i];
    }
    let r = rnd() * sum;
    let idx = 0;
    for (; idx < n - 1; idx++) {
      r -= d2[idx];
      if (r <= 0) break;
    }
    centers.push(data[idx].slice());
  }
  const labels = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist(data[i], centers[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (labels[i] !== best || it === 0) changed++;
      labels[i] = best;
    }
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      const s = sums[labels[i]];
      for (let j = 0; j < dim; j++) s[j] += data[i][j];
    }
    for (let c = 0; c < k; c++) if (counts[c]) centers[c] = Array.from(sums[c], (v) => v / counts[c]);
    if (!changed) break;
  }
  return { labels, centers };
}

function silhouette(data: number[][], labels: Int32Array, k: number, rnd: () => number, sample = 400): number {
  const n = data.length;
  const idx = Array.from({ length: Math.min(sample, n) }, () => Math.floor(rnd() * n));
  const dist = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));
  let total = 0;
  for (const i of idx) {
    const sums = new Float64Array(k);
    const counts = new Int32Array(k);
    for (const j of idx) {
      if (i === j) continue;
      sums[labels[j]] += dist(data[i], data[j]);
      counts[labels[j]]++;
    }
    const a = counts[labels[i]] ? sums[labels[i]] / counts[labels[i]] : 0;
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== labels[i] && counts[c]) b = Math.min(b, sums[c] / counts[c]);
    total += b === Infinity ? 0 : (b - a) / Math.max(a, b);
  }
  return total / idx.length;
}

function kmeans(id: number, vecs: Float32Array, n: number, dim: number, kMin: number, kMax: number, seed: number) {
  const data = rows(vecs, n, dim);
  const rnd = mulberry32(seed);
  let best: { labels: Int32Array; k: number; s: number } = { labels: new Int32Array(n), k: 1, s: -Infinity };
  for (let k = kMin; k <= Math.min(kMax, n - 1); k++) {
    post({ type: 'progress', stage: `Clustering (k=${k})`, loaded: k - kMin, total: kMax - kMin + 1 });
    const { labels } = kmeansOnce(data, k, rnd);
    // Slight penalty for many clusters → readable maps.
    const s = silhouette(data, labels, k, rnd) - 0.004 * k;
    if (s > best.s) best = { labels, k, s };
  }
  post({ type: 'kmeans', id, labels: best.labels, k: best.k, silhouette: best.s }, [best.labels.buffer as ArrayBuffer]);
}

self.onmessage = async (e: MessageEvent<MlRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'umap') await umap(m.id, m.vecs, m.n, m.dim, m.seed);
    else if (m.type === 'kmeans') kmeans(m.id, m.vecs, m.n, m.dim, m.kMin, m.kMax, m.seed);
  } catch (err) {
    post({ type: 'error', id: 'id' in m ? m.id : undefined, message: err instanceof Error ? err.message : String(err) });
  }
};

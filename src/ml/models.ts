// Behavioural / decision models computed locally on the listening history.
import { query } from '../data/db';
import { kv } from '../lib/kv';
import { loadIndex, type EmbIndex } from './embeddings';
import { auc, bootstrapCI, mean, rng, sd, shuffleInPlace } from './stats';
import { MOOD_SQL } from '../lib/mood';

// ───────────────────────── Skip prediction ─────────────────────────
// Logistic regression (L2, mini-batch GD) on engineered features, temporal split.
// Reported honestly: AUC with bootstrap CI, compared with two simpler models on the same test set:
//  - "momentum": only what happened just before (previous track skipped, track started by a skip);
//  - "preference": only properties of the track (familiarity, gap, mood, similarity).
// The full model's gain over "momentum" is what the track itself adds. Importance = mean AUC drop over
// repeated permutations (± sd); direction = sign of the model coefficient (standardized features).

interface SkipRow {
  skipped: boolean;
  hour: number;
  dow: number;
  shuffle: boolean;
  platform: string;
  reason_start: string;
  pos: number;
  prior: number;
  days_since: number | null;
  prev_skipped: boolean | null;
  valence: number | null;
  energy: number | null;
  sim_prev: number | null;
  t: number; // epoch days, for temporal split
}

export interface FeatureEffect {
  name: string;
  group: FeatureGroup;
  importance: number; // mean AUC drop when shuffled
  importanceSd: number;
  coef: number; // standardized coefficient (+ = more skips)
  direction: number; // sign of coef
  sentence: string;
}

export interface SkipModelResult {
  auc: number;
  aucCI: [number, number];
  baselines: { momentum: number; momentumCI: [number, number]; preference: number; preferenceCI: [number, number] };
  baseRate: number;
  nTrain: number;
  nTest: number;
  effects: FeatureEffect[];
  byHour: Array<{ hour: number; rate: number }>;
  byPos: Array<{ pos: number; rate: number }>;
}

type FeatureGroup = 'momentum' | 'preference' | 'context';

const FEATURES: Array<{ key: string; label: string; group: FeatureGroup; make: (r: SkipRow) => number; hi: string; lo: string }> = [
  { key: 'after_skip', label: 'Brano precedente saltato', group: 'momentum', make: (r) => (r.prev_skipped ? 1 : 0), hi: 'dopo un salto tendi a saltare ancora (raffiche di salti)', lo: 'dopo un salto di solito ti fermi sul brano successivo' },
  { key: 'by_skip', label: 'Partito perché hai premuto avanti', group: 'momentum', make: (r) => (r.reason_start === 'avanti' ? 1 : 0), hi: 'i brani arrivati con “avanti” li salti spesso: stai cercando', lo: 'quando premi avanti, il brano dopo di solito va bene' },
  { key: 'clicked', label: 'Scelto a mano (click)', group: 'context', make: (r) => (r.reason_start === 'click' ? 1 : 0), hi: 'anche i brani scelti a mano li salti', lo: 'quello che scegli a mano lo ascolti fino in fondo' },
  { key: 'autoplay', label: 'Partito alla fine del precedente', group: 'context', make: (r) => (r.reason_start === 'fine brano' ? 1 : 0), hi: 'i brani che partono da soli li salti di più', lo: 'i brani in coda automatica li lasci andare' },
  { key: 'shuffle', label: 'Shuffle attivo', group: 'context', make: (r) => (r.shuffle ? 1 : 0), hi: 'in shuffle salti di più', lo: 'in shuffle salti di meno' },
  { key: 'pos', label: 'Posizione nella sessione', group: 'context', make: (r) => Math.log1p(r.pos), hi: 'più la sessione va avanti, più salti', lo: 'a inizio sessione salti di più' },
  { key: 'night', label: 'Notte (0–6)', group: 'context', make: (r) => (r.hour < 6 ? 1 : 0), hi: 'di notte salti di più', lo: 'di notte salti di meno' },
  { key: 'evening', label: 'Sera (18–24)', group: 'context', make: (r) => (r.hour >= 18 ? 1 : 0), hi: 'la sera salti di più', lo: 'la sera salti di meno' },
  { key: 'weekend', label: 'Weekend', group: 'context', make: (r) => (r.dow >= 6 ? 1 : 0), hi: 'nel weekend salti di più', lo: 'nel weekend salti di meno' },
  { key: 'mobile', label: 'Da smartphone', group: 'context', make: (r) => (r.platform === 'iOS' || r.platform === 'Android' ? 1 : 0), hi: 'da telefono salti di più', lo: 'da telefono salti di meno' },
  { key: 'prior', label: 'Ascolti precedenti del brano', group: 'preference', make: (r) => Math.log1p(r.prior), hi: 'salti di più i brani che conosci già bene', lo: 'i brani che conosci li salti meno' },
  { key: 'fresh', label: 'Brano mai sentito prima', group: 'preference', make: (r) => (r.prior === 0 ? 1 : 0), hi: 'le novità le salti spesso', lo: 'alle novità dai una possibilità' },
  { key: 'gap', label: 'Giorni dall’ultimo ascolto', group: 'preference', make: (r) => Math.log1p(r.days_since ?? 365), hi: 'i brani “dimenticati” li salti di più', lo: 'i brani ritrovati dopo tempo li ascolti volentieri' },
  // Missing mood/similarity → 0 after centering, plus an explicit "missing" flag so missingness is not read as "average".
  { key: 'valence', label: 'Positività (valence)', group: 'preference', make: (r) => (r.valence == null ? 0 : r.valence - 0.5), hi: 'salti di più i brani allegri', lo: 'salti di più i brani tristi' },
  { key: 'energy', label: 'Energia', group: 'preference', make: (r) => (r.energy == null ? 0 : r.energy - 0.65), hi: 'salti di più i brani energici', lo: 'salti di più i brani calmi' },
  { key: 'mood_na', label: 'Mood sconosciuto', group: 'preference', make: (r) => (r.valence == null ? 1 : 0), hi: 'salti di più i brani poco noti (senza dati di mood)', lo: 'i brani senza dati di mood li salti meno' },
  { key: 'simprev', label: 'Somiglianza col brano prima', group: 'preference', make: (r) => (r.sim_prev == null ? 0 : r.sim_prev - 0.5), hi: 'salti quando il brano somiglia al precedente', lo: 'salti quando il brano cambia troppo rispetto al precedente' },
  { key: 'sim_na', label: 'Somiglianza non disponibile', group: 'preference', make: (r) => (r.sim_prev == null ? 1 : 0), hi: 'salti di più fuori dalla mappa del gusto', lo: 'fuori dalla mappa del gusto salti meno' },
];

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z));
}

export { auc };

export function trainLogistic(X: Float64Array[], y: number[], epochs = 12, lr = 0.08, l2 = 1e-3, seed = 7) {
  const d = X[0].length;
  const w = new Float64Array(d + 1);
  const n = X.length;
  const order = Array.from({ length: n }, (_, i) => i);
  const r = rng(seed);
  for (let ep = 0; ep < epochs; ep++) {
    shuffleInPlace(order, r);
    const B = 256;
    for (let s = 0; s < n; s += B) {
      const g = new Float64Array(d + 1);
      const end = Math.min(n, s + B);
      for (let t = s; t < end; t++) {
        const i = order[t];
        let z = w[d];
        for (let k = 0; k < d; k++) z += w[k] * X[i][k];
        const err = sigmoid(z) - y[i];
        for (let k = 0; k < d; k++) g[k] += err * X[i][k];
        g[d] += err;
      }
      const m = end - s;
      for (let k = 0; k < d; k++) w[k] -= lr * (g[k] / m + l2 * w[k]);
      w[d] -= lr * (g[d] / m);
    }
  }
  const predict = (x: Float64Array) => {
    let z = w[d];
    for (let k = 0; k < d; k++) z += w[k] * x[k];
    return sigmoid(z);
  };
  return Object.assign(predict, { weights: Array.from(w.subarray(0, d)), bias: w[d] });
}

function cosineAt(index: EmbIndex, pos: Map<string, number>, a: string, b: string | null): number | null {
  if (!b) return null;
  const i = pos.get(a);
  const j = pos.get(b);
  if (i == null || j == null) return null;
  let s = 0;
  for (let k = 0; k < index.dim; k++) s += index.vecs[i * index.dim + k] * index.vecs[j * index.dim + k];
  return s;
}

/** AUC with bootstrap CI for a model trained on a subset of feature columns. */
function fitSubset(X: Float64Array[], y: number[], cut: number, cols: number[], seed: number) {
  const pick = (x: Float64Array) => Float64Array.from(cols, (k) => x[k]);
  const Xs = X.map(pick);
  const m = trainLogistic(Xs.slice(0, cut), y.slice(0, cut), 12, 0.08, 1e-3, seed);
  const s = Xs.slice(cut).map(m);
  const yt = y.slice(cut);
  return { auc: auc(s, yt), ci: bootstrapCI(s.length, (ix) => auc(ix.map((i) => s[i]), ix.map((i) => yt[i])), { reps: 120, seed }) };
}

export async function trainSkipModel(opts: { permutations?: number; seed?: number } = {}): Promise<SkipModelResult | null> {
  const R = opts.permutations ?? 8;
  const seed = opts.seed ?? 1;
  const raw = await query<SkipRow & { uri: string; prev_uri: string | null }>(`
    -- Label = ended with the forward button. Recorded consistently across all years, unlike the explicit
    -- "skipped" flag, which exists only from 2022 and would make the label change meaning mid-series.
    SELECT p.reason_end = 'avanti' AS skipped, p.hour, p.dow, p.shuffle, p.platform, p.reason_start, s.pos_in_session AS pos,
           p.prior_plays AS prior, s.days_since_last AS days_since, s.prev_skipped, p.valence, p.energy,
           p.uri, s.prev_uri, epoch(p.ts) / 86400.0 AS t
    FROM p JOIN plays_seq s USING (id)
    ORDER BY p.ts`);
  if (raw.length < 500) return null;
  const index = await loadIndex();
  const pos = new Map(index?.uris.map((u, i) => [u, i]) ?? []);
  for (const r of raw) r.sim_prev = index ? cosineAt(index, pos, r.uri, r.prev_uri) : null;

  // Standardize features on the training part only (no peeking at the test period).
  const F = FEATURES.length;
  const cut = Math.floor(raw.length * 0.8);
  const Xraw = raw.map((r) => Float64Array.from(FEATURES.map((f) => f.make(r))));
  const mu = new Float64Array(F);
  const sdv = new Float64Array(F);
  for (let i = 0; i < cut; i++) for (let k = 0; k < F; k++) mu[k] += Xraw[i][k] / cut;
  for (let i = 0; i < cut; i++) for (let k = 0; k < F; k++) sdv[k] += (Xraw[i][k] - mu[k]) ** 2 / cut;
  for (let k = 0; k < F; k++) sdv[k] = Math.sqrt(sdv[k]) || 1;
  const X = Xraw.map((x) => x.map((v, k) => (v - mu[k]) / sdv[k]));
  const y: number[] = raw.map((r) => (r.skipped ? 1 : 0));

  // Temporal split: learn on the first 80%, evaluate on the most recent 20%.
  const model = trainLogistic(X.slice(0, cut), y.slice(0, cut), 12, 0.08, 1e-3, seed);
  const Xt = X.slice(cut);
  const yt = y.slice(cut);
  const st = Xt.map(model);
  const base = auc(st, yt);
  const aucCI = bootstrapCI(st.length, (ix) => auc(ix.map((i) => st[i]), ix.map((i) => yt[i])), { reps: 150, seed });

  const colsOf = (g: FeatureGroup) => FEATURES.map((f, k) => (f.group === g ? k : -1)).filter((k) => k >= 0);
  const momentum = fitSubset(X, y, cut, colsOf('momentum'), seed);
  const preference = fitSubset(X, y, cut, colsOf('preference'), seed);

  const r = rng(seed + 99);
  const effects: FeatureEffect[] = FEATURES.map((f, k) => {
    const drops: number[] = [];
    const col = Xt.map((x) => x[k]);
    for (let rep = 0; rep < R; rep++) {
      const shuffled = shuffleInPlace([...col], r);
      const scores = Xt.map((x, i) => {
        const c = Float64Array.from(x);
        c[k] = shuffled[i];
        return model(c);
      });
      drops.push(base - auc(scores, yt));
    }
    const coef = model.weights[k];
    const direction = Math.sign(coef) || 1;
    return { name: f.label, group: f.group, importance: mean(drops), importanceSd: sd(drops), coef, direction, sentence: direction >= 0 ? f.hi : f.lo };
  })
    .filter((e) => Number.isFinite(e.importance))
    .sort((a, b) => b.importance - a.importance);

  const byHour = await query<{ hour: number; rate: number }>(
    `SELECT hour, avg((reason_end = 'avanti')::INT) AS rate FROM p GROUP BY hour ORDER BY hour`,
  );
  const byPos = await query<{ pos: number; rate: number }>(
    `SELECT least(s.pos_in_session, 30) AS pos, avg((p.reason_end = 'avanti')::INT) AS rate FROM p JOIN plays_seq s USING (id) GROUP BY 1 ORDER BY 1`,
  );
  return {
    auc: base,
    aucCI,
    baselines: { momentum: momentum.auc, momentumCI: momentum.ci, preference: preference.auc, preferenceCI: preference.ci },
    baseRate: y.reduce((a, b) => a + b, 0) / y.length,
    nTrain: cut,
    nTest: X.length - cut,
    effects,
    byHour,
    byPos,
  };
}

// ───────────────────────── Eras (change-point detection) ─────────────────────────

export interface Era {
  from: string; // YYYY-MM
  to: string;
  months: number;
  topArtists: string[];
  minutes: number;
  name: string;
}

/** Monthly "taste vectors" (artist share, + embedding centroid if available) segmented with binary segmentation. */
/**
 * `penalty` is relative: a split is kept only if it removes at least that share of the total within-segment
 * variance (scale-free, so it means the same for 1 or 9 years of data).
 */
export async function detectEras(maxEras = 7, penalty = 0.04): Promise<Era[]> {
  const rows = await query<{ ym: string; artist: string; mins: number }>(`
    SELECT strftime(day, '%Y-%m') AS ym, artist, sum(minutes) AS mins FROM p GROUP BY ALL HAVING sum(minutes) > 0 ORDER BY ym`);
  if (!rows.length) return [];
  const months = Array.from(new Set(rows.map((r) => r.ym))).sort();
  if (months.length < 4) return [];
  const topArtists = await query<{ artist: string }>(`SELECT artist FROM p GROUP BY artist ORDER BY sum(minutes) DESC LIMIT 60`);
  const aidx = new Map(topArtists.map((a, i) => [a.artist, i]));
  const D = topArtists.length + 1;
  const vec = months.map(() => new Float64Array(D));
  const mIdx = new Map(months.map((m, i) => [m, i]));
  const monthMinutes = new Float64Array(months.length);
  for (const r of rows) {
    const i = mIdx.get(r.ym)!;
    vec[i][aidx.get(r.artist) ?? D - 1] += r.mins;
    monthMinutes[i] += r.mins;
  }
  // normalize to shares, sqrt (Hellinger) for stability
  for (const v of vec) {
    const s = v.reduce((a, b) => a + b, 0) || 1;
    for (let k = 0; k < D; k++) v[k] = Math.sqrt(v[k] / s);
  }
  // Binary segmentation on sum of squared distances to segment mean.
  const cost = (a: number, b: number) => {
    // [a, b)
    const mean = new Float64Array(D);
    for (let i = a; i < b; i++) for (let k = 0; k < D; k++) mean[k] += vec[i][k] / (b - a);
    let c = 0;
    for (let i = a; i < b; i++) for (let k = 0; k < D; k++) c += (vec[i][k] - mean[k]) ** 2;
    return c;
  };
  const minLen = 2;
  let segs: Array<[number, number]> = [[0, months.length]];
  const total = cost(0, months.length) || 1;
  while (segs.length < maxEras) {
    let best: { gain: number; seg: number; split: number } | null = null;
    segs.forEach(([a, b], si) => {
      const base = cost(a, b);
      for (let s = a + minLen; s <= b - minLen; s++) {
        const gain = base - cost(a, s) - cost(s, b);
        if (!best || gain > best.gain) best = { gain, seg: si, split: s };
      }
    });
    if (!best || (best as { gain: number }).gain / total < penalty) break;
    const { seg, split } = best as { seg: number; split: number };
    const [a, b] = segs[seg];
    segs.splice(seg, 1, [a, split], [split, b]);
    segs = segs.sort((x, y) => x[0] - y[0]);
  }
  const eras: Era[] = [];
  for (const [a, b] of segs) {
    const from = months[a];
    const to = months[b - 1];
    const top = await query<{ artist: string }>(
      `SELECT artist FROM p WHERE strftime(day, '%Y-%m') BETWEEN ? AND ? GROUP BY artist ORDER BY sum(minutes) DESC LIMIT 3`,
      [from, to],
    );
    let minutes = 0;
    for (let i = a; i < b; i++) minutes += monthMinutes[i];
    eras.push({
      from,
      to,
      months: b - a,
      topArtists: top.map((t) => t.artist),
      minutes,
      // Named after the people you listened to, not a genre label.
      name: top.length >= 2 ? `L’era di ${top[0].artist} e ${top[1].artist}` : `L’era di ${top[0]?.artist ?? '…'}`,
    });
  }
  const custom = (await kv.get<Record<string, string>>('era_names')) ?? {};
  for (const e of eras) if (custom[`${e.from}_${e.to}`]) e.name = custom[`${e.from}_${e.to}`];
  return eras;
}

// ───────────────────────── Artist lifecycle (Kaplan–Meier) ─────────────────────────

export interface Survival {
  curve: Array<{ days: number; survival: number }>;
  medianDays: number | null;
  loyal: Array<{ artist: string; spanDays: number; returns: number }>;
  flames: Array<{ artist: string; peakMonth: string; minutes: number; lastDay: string }>;
  churnGapDays: number;
  /** Artists in the curve, and artists left out because they were already being played when the data starts. */
  n: number;
  leftTruncated: number;
}

export interface SurvivalOpts {
  /** Drop artists first heard within `churnGapDays` of the first day in the data: their real start is unknown. */
  excludeLeftTruncated?: boolean;
  /** Minimum distinct listening days for an artist to enter the curve (selection rule, kept explicit). */
  minDays?: number;
}

export async function artistSurvival(churnGapDays = 90, opts: SurvivalOpts = {}): Promise<Survival> {
  const minDays = opts.minDays ?? 3;
  const excludeLeft = opts.excludeLeftTruncated ?? true;
  // An artist "survives" while the gap between consecutive listening days stays below churnGapDays.
  const all = await query<{ artist: string; first: string; last_active: string; censored: boolean; dur: number; returns: number; left: boolean }>(`
    WITH d AS (SELECT DISTINCT artist, day FROM p WHERE counted),
    g AS (SELECT artist, day, date_diff('day', lag(day) OVER (PARTITION BY artist ORDER BY day), day) AS gap FROM d),
    agg AS (
      SELECT artist, min(day) AS first_d,
        -- end of first "life": last day before the first long gap
        coalesce(min(day) FILTER (WHERE gap > ${churnGapDays}), max(day) + 1) AS first_break,
        count(*) FILTER (WHERE gap > ${churnGapDays}) AS returns
      FROM g GROUP BY artist HAVING count(*) >= ${Math.max(1, Math.floor(minDays))}
    ),
    life AS (
      SELECT a.artist, a.first_d, a.returns,
        (SELECT max(day) FROM g WHERE g.artist = a.artist AND g.day < a.first_break) AS last_active
      FROM agg AS a
    )
    SELECT artist, first_d::VARCHAR AS first, last_active::VARCHAR AS last_active, returns,
      date_diff('day', first_d, last_active) AS dur,
      date_diff('day', last_active, (SELECT max(day) FROM p)) < ${churnGapDays} AND returns = 0 censored,
      date_diff('day', (SELECT min(day) FROM p), first_d) < ${churnGapDays} AS "left"
    FROM life`);
  const rows = excludeLeft ? all.filter((r) => !r.left) : all;
  // Kaplan–Meier
  const events = rows.map((r) => ({ t: Math.max(1, r.dur), e: !r.censored })).sort((a, b) => a.t - b.t);
  let atRisk = events.length;
  let s = 1;
  const curve: Array<{ days: number; survival: number }> = [{ days: 0, survival: 1 }];
  let i = 0;
  let median: number | null = null;
  while (i < events.length) {
    const t = events[i].t;
    let d = 0;
    let c = 0;
    while (i < events.length && events[i].t === t) {
      if (events[i].e) d++;
      else c++;
      i++;
    }
    if (d && atRisk) {
      s *= 1 - d / atRisk;
      curve.push({ days: t, survival: s });
      if (median == null && s <= 0.5) median = t;
    }
    atRisk -= d + c;
  }
  const loyal = await query<{ artist: string; spanDays: number; returns: number }>(`
    WITH d AS (SELECT DISTINCT artist, day FROM p WHERE counted),
    g AS (SELECT artist, day, date_diff('day', lag(day) OVER (PARTITION BY artist ORDER BY day), day) AS gap FROM d)
    SELECT artist, date_diff('day', min(day), max(day)) "spanDays", count(*) FILTER (WHERE gap > ${churnGapDays}) AS returns
    FROM g GROUP BY artist HAVING count(*) >= 10 ORDER BY returns DESC, "spanDays" DESC LIMIT 8`);
  const flames = await query<{ artist: string; peakMonth: string; minutes: number; lastDay: string }>(`
    WITH m AS (SELECT artist, strftime(day, '%Y-%m') AS ym, sum(minutes) AS mins FROM p GROUP BY ALL),
    tot AS (SELECT artist, sum(mins) AS total, max(mins) AS peak, arg_max(ym, mins) "peakMonth" FROM m GROUP BY artist),
    last AS (SELECT artist, max(day) "lastDay" FROM p GROUP BY artist)
    SELECT tot.artist, "peakMonth", total AS minutes, "lastDay"::VARCHAR "lastDay" FROM tot JOIN last USING (artist)
    WHERE peak / total > 0.6 AND total > 60 AND date_diff('day', "lastDay", (SELECT max(day) FROM p)) > ${churnGapDays}
    ORDER BY total DESC LIMIT 8`);
  return { curve, medianDays: median, loyal, flames, churnGapDays, n: rows.length, leftTruncated: all.length - rows.length };
}

// ───────────────────────── Sensitivity analyses ─────────────────────────
// Every arbitrary threshold is re-run over a range of values, so a reader can see whether a conclusion
// depends on the choice.

export interface SensitivityReport {
  survival: Array<{ churnGapDays: number; medianDays: number | null; n: number; leftTruncated: number }>;
  survivalNoTruncation: { medianDays: number | null; n: number };
  eras: Array<{ penalty: number; eras: number; boundaries: string[] }>;
  /** Share of boundaries found at the default penalty that reappear (±1 month) at every other penalty. */
  eraStability: number;
  moodShift: Array<{ dv: number; de: number; shares: Record<string, number> }>;
}

export async function sensitivity(): Promise<SensitivityReport> {
  const survival = [];
  for (const g of [30, 60, 90, 180]) {
    const s = await artistSurvival(g);
    survival.push({ churnGapDays: g, medianDays: s.medianDays, n: s.n, leftTruncated: s.leftTruncated });
  }
  const nt = await artistSurvival(90, { excludeLeftTruncated: false });

  const eras = [];
  for (const penalty of [0.02, 0.04, 0.08]) {
    const e = await detectEras(12, penalty);
    eras.push({ penalty, eras: e.length, boundaries: e.slice(1).map((x) => x.from) });
  }
  const monthNo = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
  // Reference = default penalty; a boundary is "stable" if a finer and a coarser segmentation both keep it.
  const ref = eras.find((e) => e.penalty === 0.04)!.boundaries;
  const others = eras.filter((e) => e.penalty !== 0.04 && e.eras > 1);
  const stable = ref.filter((b) => others.every((o) => o.boundaries.some((x) => Math.abs(monthNo(x) - monthNo(b)) <= 1)));
  const eraStability = ref.length ? stable.length / ref.length : 1;

  const moodShift = [];
  for (const dv of [-0.05, 0, 0.05])
    for (const de of [-0.05, 0, 0.05]) {
      const r = await query<{ mood: string; mins: number }>(
        `SELECT ${MOOD_SQL(`valence - (${dv})`, `energy - (${de})`)} AS mood, sum(minutes) AS mins FROM p WHERE valence IS NOT NULL GROUP BY 1`,
      );
      const tot = r.reduce((a, b) => a + b.mins, 0) || 1;
      moodShift.push({ dv, de, shares: Object.fromEntries(r.map((x) => [x.mood, x.mins / tot])) });
    }
  return { survival, survivalNoTruncation: { medianDays: nt.medianDays, n: nt.n }, eras, eraStability, moodShift };
}

// ───────────────────────── Rediscovery (Thompson sampling bandit) ─────────────────────────

export interface Candidate {
  uri: string;
  track: string;
  artist: string;
  cover: string | null;
  plays: number;
  last_day: string;
  cluster: number | null;
  cluster_label: string | null;
  score: number;
}

type Arms = Record<string, { a: number; b: number }>;

function betaSample(a: number, b: number) {
  // Gamma via Marsaglia–Tsang (shape ≥ 1 guaranteed by priors ≥ 1)
  const gamma = (k: number) => {
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        const u1 = Math.random();
        const u2 = Math.random();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const x = gamma(a);
  const y = gamma(b);
  return x / (x + y);
}

export async function rediscoveryCandidates(n = 12, minGapDays = 180): Promise<Candidate[]> {
  const pool = await query<Omit<Candidate, 'score'>>(`
    SELECT t.uri, t.track, t.artist, m.cover, t.plays, t.last_day::VARCHAR AS last_day, m.cluster, c.label AS cluster_label
    FROM tracks t LEFT JOIN meta m USING (uri) LEFT JOIN clusters c ON c.id = m.cluster
    WHERE t.plays >= 5 AND t.skip_rate < 0.5
      AND date_diff('day', t.last_day, (SELECT max(day) FROM plays)) >= ${minGapDays}
    ORDER BY t.plays DESC LIMIT 600`);
  const arms = (await kv.get<Arms>('bandit_arms')) ?? {};
  const fb = (await kv.get<Record<string, number>>('bandit_feedback')) ?? {};
  const scored = pool
    .filter((c) => fb[c.uri] == null)
    .map((c) => {
      const arm = arms[c.cluster == null ? 'none' : String(c.cluster)] ?? { a: 1, b: 1 };
      const prior = Math.min(1, Math.log1p(c.plays) / 4);
      return { ...c, score: betaSample(arm.a, arm.b) * 0.7 + prior * 0.3 + Math.random() * 0.05 };
    })
    .sort((a, b) => b.score - a.score);
  // Diversity: max 2 per artist.
  const per = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of scored) {
    const k = per.get(c.artist) ?? 0;
    if (k >= 2) continue;
    per.set(c.artist, k + 1);
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

export async function rediscoveryFeedback(c: Candidate, liked: boolean) {
  const arms = (await kv.get<Arms>('bandit_arms')) ?? {};
  const key = c.cluster == null ? 'none' : String(c.cluster);
  const arm = arms[key] ?? { a: 1, b: 1 };
  if (liked) arm.a += 1;
  else arm.b += 1;
  arms[key] = arm;
  const fb = (await kv.get<Record<string, number>>('bandit_feedback')) ?? {};
  fb[c.uri] = liked ? 1 : 0;
  await kv.setMany([
    ['bandit_arms', arms],
    ['bandit_feedback', fb],
  ]);
}

// ───────────────────────── Routines & sessions ─────────────────────────

export interface SessionStats {
  sessions: number;
  avgMinutes: number;
  avgTracks: number;
  longest: { day: string; minutes: number; tracks: number } | null;
  kinds: Array<{ kind: string; n: number; desc: string }>;
}

export async function sessionStats(): Promise<SessionStats> {
  const s = await query<{ sessions: number; avg_min: number; avg_tracks: number }>(`
    WITH s AS (SELECT session_id, sum(minutes) AS mins, count(*) AS n FROM p GROUP BY session_id)
    SELECT count(*) AS sessions, avg(mins) AS avg_min, avg(n) AS avg_tracks FROM s`);
  const longest = await query<{ day: string; minutes: number; tracks: number }>(`
    SELECT min(day)::VARCHAR AS day, sum(minutes) AS minutes, count(*) AS tracks FROM p GROUP BY session_id ORDER BY minutes DESC LIMIT 1`);
  const kinds = await query<{ kind: string; n: number }>(`
    WITH s AS (
      SELECT session_id, count(*) AS n, sum(minutes) AS mins, count(DISTINCT artist) AS artists, avg(skipped::INT) AS skip,
             avg(CASE WHEN prior_plays = 0 THEN 1 ELSE 0 END) AS fresh
      FROM p GROUP BY session_id HAVING count(*) >= 3)
    SELECT CASE
      WHEN skip > 0.6 THEN 'Ricerca'
      WHEN fresh > 0.5 THEN 'Esplorazione'
      WHEN artists <= 2 THEN 'Monografica'
      WHEN mins > 90 THEN 'Maratona'
      ELSE 'Abitudine' END kind, count(*) AS n
    FROM s GROUP BY 1 ORDER BY n DESC`);
  const desc: Record<string, string> = {
    Ricerca: 'salti molto: cerchi il brano giusto',
    Esplorazione: 'più di metà brani mai sentiti prima',
    Monografica: 'uno o due artisti, tutta la sessione',
    Maratona: 'oltre un’ora e mezza senza pause',
    Abitudine: 'i tuoi brani di sempre',
  };
  return {
    sessions: s[0]?.sessions ?? 0,
    avgMinutes: s[0]?.avg_min ?? 0,
    avgTracks: s[0]?.avg_tracks ?? 0,
    longest: longest[0] ?? null,
    kinds: kinds.map((k) => ({ ...k, desc: desc[k.kind] ?? '' })),
  };
}

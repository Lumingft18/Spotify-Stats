// Reading aids for the taste map. UMAP axes have no fixed meaning (it keeps neighbours, not a scale), so
// nothing is assumed: each axis is labelled only with features that MEASURABLY vary along it on this map,
// and genre names are placed only where that genre is actually concentrated.
import { pearson } from './stats';

export interface AxisRow {
  x: number;
  y: number;
  valence: number | null;
  energy: number | null;
  danceability: number | null;
  acousticness: number | null;
  year: number | null;
  tags: string | null;
}

const FEATURES = [
  { key: 'energy', name: 'energia', lo: 'più calmo', hi: 'più energico' },
  { key: 'valence', name: 'positività (valence)', lo: 'più cupo', hi: 'più positivo' },
  { key: 'danceability', name: 'ballabilità', lo: 'meno ballabile', hi: 'più ballabile' },
  { key: 'acousticness', name: 'acusticità', lo: 'più elettronico', hi: 'più acustico' },
  { key: 'year', name: 'anno di scoperta', lo: 'scoperti prima', hi: 'scoperti dopo' },
] as const;

/** |r| below this is not shown: the direction would be noise. */
export const AXIS_MIN_R = 0.25;
const MIN_N = 100;

export interface AxisReading {
  /** Text toward the low end of the axis (left for x, top for y on screen) and the high end. */
  low: string;
  high: string;
  r: number;
  /** Italian name of the feature. */
  feature: string;
  n: number;
}

function best(rows: AxisRow[], coord: 'x' | 'y'): AxisReading | null {
  let out: AxisReading | null = null;
  for (const f of FEATURES) {
    const ok = rows.filter((r) => r[f.key] != null && Number.isFinite(r[f.key] as number));
    if (ok.length < MIN_N) continue;
    const r = pearson(
      ok.map((p) => p[coord]),
      ok.map((p) => p[f.key] as number),
    );
    if (!Number.isFinite(r) || Math.abs(r) < AXIS_MIN_R) continue;
    if (!out || Math.abs(r) > Math.abs(out.r)) {
      out = { low: r > 0 ? f.lo : f.hi, high: r > 0 ? f.hi : f.lo, r, feature: f.name, n: ok.length };
    }
  }
  return out;
}

/** Strongest measured feature along each map axis (null = no feature explains it). */
export function mapAxes(rows: AxisRow[]): { x: AxisReading | null; y: AxisReading | null } {
  return { x: best(rows, 'x'), y: best(rows, 'y') };
}

/** Frequent Last.fm/MusicBrainz tags that are not genres. */
const NOT_GENRES = new Set([
  'seen live', 'favorite', 'favorites', 'favourite', 'favourites', 'love', 'loved', 'awesome', 'beautiful', 'cool', 'amazing',
  'x factor', 'international', 'spotify', 'albums i own', 'under 2000 listeners', 'my music', 'all', 'misc', 'other', 'music',
  'male vocalists', 'female vocalists', 'male vocalist', 'female vocalist', 'catchy', 'chill', 'sexy', 'cover', 'covers',
  'soundtrack', 'youtube', 'tiktok', 'viral', 'radio', 'live', 'best', 'good', 'great', 'fun', 'sad', 'happy', 'summer',
])

/**
 * Genre landmarks: centroid of the tracks carrying a tag, kept only when those tracks sit close together
 * (mean distance to their centroid < 60% of the map's overall spread) and away from an already placed one.
 */
export function genreLandmarks(rows: AxisRow[], max = 10): Array<{ x: number; y: number; text: string; n: number }> {
  if (rows.length < 50) return [];
  const cx = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const cy = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const spread = rows.reduce((s, r) => s + Math.hypot(r.x - cx, r.y - cy), 0) / rows.length || 1;

  const byTag = new Map<string, AxisRow[]>();
  for (const r of rows) {
    for (const t of new Set((r.tags ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))) {
      if (t.length > 22 || NOT_GENRES.has(t) || /^\d{2,4}s?$/.test(t)) continue;
      const list = byTag.get(t) ?? [];
      list.push(r);
      byTag.set(t, list);
    }
  }
  const minN = Math.max(12, Math.round(rows.length * 0.006));
  const cands = [...byTag]
    .filter(([, l]) => l.length >= minN)
    .map(([text, l]) => {
      const x = l.reduce((s, r) => s + r.x, 0) / l.length;
      const y = l.reduce((s, r) => s + r.y, 0) / l.length;
      const tight = l.reduce((s, r) => s + Math.hypot(r.x - x, r.y - y), 0) / l.length / spread;
      return { text, x, y, n: l.length, tight };
    })
    .filter((c) => c.tight < 0.6)
    // Big AND concentrated genres first (a tiny tight tag like a TV show name shouldn't win over "rap").
    .map((c) => ({ ...c, score: c.n * (1 - c.tight / 0.6) }))
    .sort((a, b) => b.score - a.score);
  const out: Array<{ x: number; y: number; text: string; n: number }> = [];
  for (const c of cands) {
    if (out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < spread * 0.35)) continue;
    out.push({ x: c.x, y: c.y, text: c.text, n: c.n });
    if (out.length >= max) break;
  }
  return out;
}

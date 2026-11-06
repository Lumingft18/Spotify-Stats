// Every fact the story and the PDF report tell, computed once from `plays` (+ meta) for a WHERE clause on alias `p`.
import { query } from './db';
import { MOOD_SQL, type Mood } from '../lib/mood';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** WHERE for one calendar year (0 = every year). */
export function yearWhere(year: number): string {
  return year ? `p.kind = 'track' AND year(p.day) = ${Math.floor(year)}` : `p.kind = 'track'`;
}

/** WHERE for the app's date range filter. Dates are validated (no injection). */
export function rangeWhere(from: string | null, to: string | null): string {
  const c = [`p.kind = 'track'`];
  if (from && DATE_RE.test(from)) c.push(`p.day >= DATE '${from}'`);
  if (to && DATE_RE.test(to)) c.push(`p.day <= DATE '${to}'`);
  return c.join(' AND ');
}

export interface DayTrack {
  track: string;
  artist: string;
  cover: string | null;
  n: number;
}

export interface MoodDay {
  day: string;
  minutes: number;
  valence: number;
  energy: number;
  tracks: DayTrack[];
}

export interface Facts {
  /** 0 = all years */
  year: number;
  label: string;
  minutes: number;
  plays: number;
  days: number;
  activeDays: number;
  uniqueTracks: number;
  artistsCount: number;
  skip: number;
  shuffle: number;
  firstDay: string;
  lastDay: string;
  byYear: Array<{ year: number; minutes: number; artist: string; cover: string | null; track: string; mood: Mood | null }>;
  topMonth: { ym: string; minutes: number } | null;
  topDay: { day: string; minutes: number } | null;
  artist: { artist: string; minutes: number; cover: string | null; share: number } | null;
  artists5: Array<{ artist: string; minutes: number; cover: string | null }>;
  tracks5: Array<{ uri: string; track: string; artist: string; plays: number; cover: string | null }>;
  mood: { mood: Mood; share: number } | null;
  moodMix: Array<{ mood: Mood; share: number }>;
  /** Share of minutes whose track has a known mood. */
  moodCoverage: number;
  happyDay: MoodDay | null;
  sadDay: MoodDay | null;
  wildDay: MoodDay | null;
  calmDay: MoodDay | null;
  happyTrack: { track: string; artist: string; cover: string | null; valence: number } | null;
  sadTrack: { track: string; artist: string; cover: string | null; valence: number } | null;
  peak: { dow: number; hour: number } | null;
  newArtists: number;
  newTop: { artist: string; minutes: number } | null;
  streak: { from: string; to: string; days: number } | null;
  marathon: { start: string; minutes: number; tracks: number } | null;
  obsession: { track: string; artist: string; cover: string | null; day: string; n: number } | null;
  comeback: { track: string; artist: string; cover: string | null; day: string; gap: number } | null;
  night: { share: number; track: string | null; artist: string | null } | null;
  firstTrack: { track: string; artist: string; day: string } | null;
  lastTrack: { track: string; artist: string; day: string } | null;
  weekendShare: number;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

async function dayTracks(w: string, days: string[]): Promise<Map<string, DayTrack[]>> {
  const out = new Map<string, DayTrack[]>();
  const valid = days.filter((d) => DATE_RE.test(d));
  if (!valid.length) return out;
  const rows = await query<DayTrack & { day: string }>(`
    WITH x AS (
      SELECT p.day::VARCHAR AS day, any_value(p.track) AS track, any_value(p.artist) AS artist, any_value(m.cover) AS cover, count(*) AS n, sum(p.minutes) AS mins
      FROM plays p LEFT JOIN meta m USING (uri)
      WHERE ${w} AND p.day IN (${valid.map((d) => `DATE '${d}'`).join(',')}) GROUP BY p.day, p.uri)
    SELECT * FROM x QUALIFY row_number() OVER (PARTITION BY day ORDER BY mins DESC) <= 4 ORDER BY day, mins DESC`);
  for (const r of rows) {
    const list = out.get(r.day) ?? [];
    list.push({ track: r.track, artist: r.artist, cover: r.cover, n: r.n });
    out.set(r.day, list);
  }
  return out;
}

export async function loadFacts(w: string, year: number): Promise<Facts | null> {
  const all = year === 0;
  const k = (
    await query<{ minutes: number; plays: number; active: number; skip: number; shuffle: number; uniq: number; artists: number; first: string; last: string; span: number; weekend: number }>(`
      SELECT sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays, count(DISTINCT day) AS active, avg(skipped::INT) AS skip, avg(shuffle::INT) AS shuffle,
             count(DISTINCT uri) FILTER (WHERE counted) AS uniq, count(DISTINCT artist) FILTER (WHERE counted) AS artists,
             min(day)::VARCHAR AS first, max(day)::VARCHAR AS last, date_diff('day', min(day), max(day)) + 1 AS span,
             sum(minutes) FILTER (WHERE dow >= 6) / nullif(sum(minutes), 0) AS weekend
      FROM plays p WHERE ${w}`)
  )[0];
  if (!k?.minutes) return null;
  const total = k.minutes;

  const [topMonth, topDay, artists5, tracks5, moodRows, peak, newA, byYear] = await Promise.all([
    query<{ ym: string; minutes: number }>(`SELECT strftime(day,'%Y-%m') AS ym, sum(minutes) AS minutes FROM plays p WHERE ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`),
    query<{ day: string; minutes: number }>(`SELECT day::VARCHAR AS day, sum(minutes) AS minutes FROM plays p WHERE ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`),
    query<{ artist: string; minutes: number; cover: string | null }>(`
      SELECT p.artist, sum(p.minutes) AS minutes, arg_max(m.cover, p.minutes) FILTER (WHERE m.cover <> '') AS cover
      FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`),
    query<{ uri: string; track: string; artist: string; plays: number; cover: string | null }>(`
      SELECT p.uri, any_value(p.track) AS track, any_value(p.artist) AS artist, count(*) FILTER (WHERE p.counted) AS plays, any_value(m.cover) AS cover
      FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w} GROUP BY 1 ORDER BY plays DESC LIMIT 5`),
    query<{ mood: Mood; minutes: number }>(`
      SELECT ${MOOD_SQL('m.valence', 'm.energy')} AS mood, sum(p.minutes) AS minutes FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w} GROUP BY 1`),
    query<{ dow: number; hour: number }>(`SELECT dow, hour FROM plays p WHERE ${w} GROUP BY ALL ORDER BY sum(minutes) DESC LIMIT 1`),
    query<{ n: number }>(`
      WITH f AS (SELECT artist, min(day) AS first_d FROM plays WHERE kind = 'track' AND counted GROUP BY artist)
      SELECT count(*) AS n FROM f ${all ? '' : `WHERE year(first_d) = ${Math.floor(year)}`}`),
    query<{ year: number; minutes: number; artist: string; cover: string | null; track: string; mood: Mood | null }>(`
      WITH y AS (SELECT year(p.day) AS year, p.artist, p.track, p.minutes, m.cover, m.valence, m.energy FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w}),
      a AS (SELECT year, artist, sum(minutes) AS m, arg_max(cover, minutes) FILTER (WHERE cover <> '') AS cover FROM y GROUP BY ALL),
      t AS (SELECT year, track, artist, sum(minutes) AS m FROM y GROUP BY ALL),
      md AS (SELECT year, ${MOOD_SQL('valence', 'energy')} AS mood, sum(minutes) AS m FROM y GROUP BY ALL)
      SELECT tot.year, tot.minutes, ta.artist, ta.cover, tt.track || ' — ' || tt.artist AS track, mm.mood
      FROM (SELECT year, sum(minutes) AS minutes FROM y GROUP BY year) tot
      JOIN (SELECT * FROM a QUALIFY row_number() OVER (PARTITION BY year ORDER BY m DESC) = 1) ta USING (year)
      JOIN (SELECT * FROM t QUALIFY row_number() OVER (PARTITION BY year ORDER BY m DESC) = 1) tt USING (year)
      LEFT JOIN (SELECT * FROM md WHERE mood <> 'sconosciuto' QUALIFY row_number() OVER (PARTITION BY year ORDER BY m DESC) = 1) mm USING (year)
      ORDER BY tot.year`),
  ]);

  const newTop = all
    ? []
    : await query<{ artist: string; minutes: number }>(`
        WITH f AS (SELECT artist, min(day) AS first_d FROM plays WHERE kind = 'track' AND counted GROUP BY artist)
        SELECT p.artist, sum(p.minutes) AS minutes FROM plays p JOIN f USING (artist)
        WHERE year(f.first_d) = ${Math.floor(year)} AND ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);

  // Mood days: only days with ≥ 45 min of known-mood music and ≥ 60% of the day covered (no single-track flukes).
  const moodDays = await query<{ day: string; minutes: number; v: number; e: number }>(`
    WITH d AS (
      SELECT p.day, sum(p.minutes) AS minutes,
        sum(p.minutes) FILTER (WHERE m.valence IS NOT NULL) AS known,
        sum(m.valence * p.minutes) FILTER (WHERE m.valence IS NOT NULL) / nullif(sum(p.minutes) FILTER (WHERE m.valence IS NOT NULL), 0) AS v,
        sum(m.energy * p.minutes) FILTER (WHERE m.energy IS NOT NULL) / nullif(sum(p.minutes) FILTER (WHERE m.energy IS NOT NULL), 0) AS e
      FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w} GROUP BY p.day)
    SELECT day::VARCHAR AS day, minutes, v, e FROM d WHERE known >= 45 AND known >= 0.6 * minutes AND v IS NOT NULL`);
  // Each title goes to a different day (the saddest day is often also the calmest).
  const used = new Set<string>();
  const pick = (score: (d: (typeof moodDays)[number]) => number | null) => {
    const best = moodDays.filter((d) => !used.has(d.day) && score(d) != null).sort((a, b) => score(b)! - score(a)!)[0] ?? null;
    if (best) used.add(best.day);
    return best;
  };
  const happy = pick((d) => d.v);
  const sad = pick((d) => -d.v);
  const wild = pick((d) => (d.e == null ? null : d.e));
  const calm = pick((d) => (d.e == null ? null : -d.e));
  const tracksOf = await dayTracks(w, [happy, sad, wild, calm].filter(Boolean).map((d) => d!.day));
  const md = (d: (typeof moodDays)[number] | null): MoodDay | null =>
    d ? { day: d.day, minutes: d.minutes, valence: d.v, energy: d.e, tracks: tracksOf.get(d.day) ?? [] } : null;

  const [extremes, streak, marathon, obsession, comeback, night, firstLast] = await Promise.all([
    query<{ track: string; artist: string; cover: string | null; valence: number; kind: string }>(`
      WITH t AS (
        SELECT any_value(p.track) AS track, any_value(p.artist) AS artist, any_value(m.cover) AS cover, any_value(m.valence) AS valence, count(*) FILTER (WHERE p.counted) AS n
        FROM plays p JOIN meta m USING (uri) WHERE ${w} AND m.valence IS NOT NULL GROUP BY p.uri),
      top AS (SELECT * FROM t ORDER BY n DESC LIMIT 60)
      (SELECT track, artist, cover, valence, 'happy' AS kind FROM top ORDER BY valence DESC LIMIT 1)
      UNION ALL
      (SELECT track, artist, cover, valence, 'sad' AS kind FROM top ORDER BY valence ASC LIMIT 1)`),
    query<{ from_d: string; to_d: string; n: number }>(`
      WITH d AS (SELECT DISTINCT day FROM plays p WHERE ${w}),
      g AS (SELECT day, day - CAST(row_number() OVER (ORDER BY day) AS INTEGER) AS grp FROM d)
      SELECT min(day)::VARCHAR AS from_d, max(day)::VARCHAR AS to_d, count(*) AS n FROM g GROUP BY grp ORDER BY n DESC LIMIT 1`),
    query<{ start: string; minutes: number; tracks: number }>(`
      SELECT strftime(min(tl), '%Y-%m-%d %H:%M') AS start, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS tracks
      FROM plays p WHERE ${w} GROUP BY session_id ORDER BY minutes DESC LIMIT 1`),
    query<{ track: string; artist: string; cover: string | null; day: string; n: number }>(`
      SELECT any_value(p.track) AS track, any_value(p.artist) AS artist, any_value(m.cover) AS cover, p.day::VARCHAR AS day, count(*) FILTER (WHERE p.counted) AS n
      FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w} GROUP BY p.uri, p.day ORDER BY n DESC LIMIT 1`),
    query<{ track: string; artist: string; cover: string | null; day: string; gap: number }>(`
      SELECT p.track, p.artist, m.cover, p.day::VARCHAR AS day, s.days_since_last AS gap
      FROM plays p JOIN plays_seq s USING (id) LEFT JOIN meta m USING (uri)
      WHERE ${w} AND p.counted AND s.days_since_last IS NOT NULL ORDER BY s.days_since_last DESC LIMIT 1`),
    query<{ share: number; track: string | null; artist: string | null }>(`
      SELECT sum(minutes) FILTER (WHERE hour < 5) / nullif(sum(minutes), 0) AS share,
             arg_max(track, minutes) FILTER (WHERE hour < 5) AS track, arg_max(artist, minutes) FILTER (WHERE hour < 5) AS artist
      FROM plays p WHERE ${w}`),
    query<{ ft: string; fa: string; fd: string; lt: string; la: string; ld: string }>(`
      SELECT arg_min(track, ts) AS ft, arg_min(artist, ts) AS fa, min(day)::VARCHAR AS fd,
             arg_max(track, ts) AS lt, arg_max(artist, ts) AS la, max(day)::VARCHAR AS ld
      FROM plays p WHERE ${w} AND counted`),
  ]);

  const known = moodRows.filter((r) => r.mood !== 'sconosciuto');
  const knownTotal = known.reduce((s, r) => s + r.minutes, 0);
  const moodMix = known.map((r) => ({ mood: r.mood, share: r.minutes / knownTotal })).sort((a, b) => b.share - a.share);
  const happyT = extremes.find((e) => e.kind === 'happy');
  const sadT = extremes.find((e) => e.kind === 'sad');
  const fl = firstLast[0];

  return {
    year,
    label: all ? 'tutti gli anni' : String(year),
    minutes: total,
    plays: k.plays,
    days: all ? k.span : isLeap(year) ? 366 : 365,
    activeDays: k.active,
    uniqueTracks: k.uniq,
    artistsCount: k.artists,
    skip: k.skip,
    shuffle: k.shuffle,
    firstDay: k.first,
    lastDay: k.last,
    byYear,
    topMonth: topMonth[0] ?? null,
    topDay: topDay[0] ?? null,
    artist: artists5[0] ? { ...artists5[0], share: artists5[0].minutes / total } : null,
    artists5,
    tracks5,
    mood: moodMix[0] ? { mood: moodMix[0].mood, share: moodMix[0].share } : null,
    moodMix,
    moodCoverage: knownTotal / total,
    happyDay: md(happy),
    sadDay: md(sad),
    wildDay: md(wild),
    calmDay: md(calm),
    happyTrack: happyT ? { track: happyT.track, artist: happyT.artist, cover: happyT.cover, valence: happyT.valence } : null,
    sadTrack: sadT && sadT.track !== happyT?.track ? { track: sadT.track, artist: sadT.artist, cover: sadT.cover, valence: sadT.valence } : null,
    peak: peak[0] ?? null,
    newArtists: newA[0]?.n ?? 0,
    newTop: newTop[0] ?? null,
    streak: streak[0] ? { from: streak[0].from_d, to: streak[0].to_d, days: streak[0].n } : null,
    marathon: marathon[0] ?? null,
    obsession: obsession[0] && obsession[0].n > 1 ? obsession[0] : null,
    comeback: comeback[0] && comeback[0].gap >= 60 ? comeback[0] : null,
    night: night[0]?.share ? night[0] : null,
    firstTrack: fl?.ft ? { track: fl.ft, artist: fl.fa, day: fl.fd } : null,
    lastTrack: fl?.lt ? { track: fl.lt, artist: fl.la, day: fl.ld } : null,
    weekendShare: k.weekend ?? 0,
  };
}

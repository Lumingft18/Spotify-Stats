// Shared SQL used across screens. All read from the filtered view `p` unless stated.

export const KPI_SQL = `
SELECT
  coalesce(sum(minutes), 0)                                  AS minutes,
  count(*) FILTER (WHERE counted)                            AS plays,
  count(*)                                                   AS starts,
  count(DISTINCT uri) FILTER (WHERE counted)                 AS tracks,
  count(DISTINCT artist) FILTER (WHERE counted)              AS artists,
  count(DISTINCT artist || '|' || album) FILTER (WHERE counted) AS albums,
  count(DISTINCT day)                                        AS active_days,
  min(day)::VARCHAR                                          AS first_day,
  max(day)::VARCHAR                                          AS last_day,
  avg(skipped::INT)                                          AS skip_rate,
  avg(shuffle::INT)                                          AS shuffle_rate,
  count(DISTINCT session_id)                                 AS sessions,
  avg((prior_plays = 0)::INT) FILTER (WHERE counted)         AS discovery_rate
FROM p`;

export interface Kpi {
  minutes: number;
  plays: number;
  starts: number;
  tracks: number;
  artists: number;
  albums: number;
  active_days: number;
  first_day: string | null;
  last_day: string | null;
  skip_rate: number;
  shuffle_rate: number;
  sessions: number;
  discovery_rate: number;
}

/** Same KPIs over an explicit window on `plays` (used for period-over-period deltas). */
export const KPI_WINDOW_SQL = `
SELECT coalesce(sum(minutes), 0) AS minutes, count(*) FILTER (WHERE counted) AS plays,
       count(DISTINCT artist) FILTER (WHERE counted) AS artists, count(DISTINCT uri) FILTER (WHERE counted) AS tracks
FROM plays WHERE kind = 'track' AND day BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)`;

export const MONTHLY_SQL = `
SELECT strftime(day, '%Y-%m') AS ym, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays
FROM p GROUP BY 1 ORDER BY 1`;

export type TopKind = 'artists' | 'tracks' | 'albums';

export function topSql(kind: TopKind, orderBy: 'minutes' | 'plays' = 'minutes', limit = 50, offset = 0, search = false) {
  const where = search ? `WHERE lower(label) LIKE ?` : '';
  const order = orderBy === 'plays' ? 'plays DESC, minutes DESC' : 'minutes DESC';
  if (kind === 'artists')
    return `
    WITH a AS (
      SELECT artist AS label, artist, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays,
             avg(skipped::INT) AS skip_rate, count(DISTINCT uri) FILTER (WHERE counted) AS n_tracks,
             arg_max(cover, minutes) FILTER (WHERE cover IS NOT NULL AND cover <> '') AS cover, min(day)::VARCHAR AS first_day
      FROM p GROUP BY artist)
    SELECT * FROM a ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
  if (kind === 'albums')
    return `
    WITH a AS (
      SELECT album AS label, artist, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays,
             avg(skipped::INT) AS skip_rate, count(DISTINCT uri) FILTER (WHERE counted) AS n_tracks,
             any_value(cover) FILTER (WHERE cover IS NOT NULL AND cover <> '') AS cover, min(day)::VARCHAR AS first_day
      FROM p WHERE album <> '' GROUP BY album, artist)
    SELECT * FROM a ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
  return `
    WITH a AS (
      SELECT any_value(track) AS label, uri, any_value(artist) AS artist, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays,
             avg(skipped::INT) AS skip_rate, any_value(cover) AS cover, min(day)::VARCHAR AS first_day, any_value(valence) AS valence, any_value(energy) AS energy
      FROM p GROUP BY uri)
    SELECT * FROM a ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`;
}

export interface TopRow {
  label: string;
  artist: string;
  uri?: string;
  minutes: number;
  plays: number;
  skip_rate: number;
  n_tracks?: number;
  cover: string | null;
  first_day: string;
  valence?: number | null;
  energy?: number | null;
}

export const HOUR_DOW_SQL = `
WITH d AS (SELECT dow, count(DISTINCT day) AS nd FROM p GROUP BY dow)
SELECT p.dow, p.hour, sum(p.minutes) / greatest(1, any_value(d.nd)) AS avg_minutes, sum(p.minutes) AS minutes
FROM p JOIN d USING (dow) GROUP BY p.dow, p.hour`;

export const DAILY_SQL = `SELECT day::VARCHAR AS day, sum(minutes) AS minutes FROM p GROUP BY day ORDER BY day`;

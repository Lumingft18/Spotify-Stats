// Data-quality report: what the cleaning rules removed and how stable the raw signals are over time.
import { query } from './db';

export interface QualityReport {
  rawRows: number;
  rows: number;
  duplicatesRemoved: number;
  excludedRows: number;
  short: number; // plays < 30 s (kept, but not counted as "ascolti")
  byYear: Array<{ year: number; plays: number; skipRate: number; fwdShare: number; mobileShare: number; shuffleShare: number }>;
  mood: Array<{ source: string; tracks: number; minutesShare: number }>;
}

export async function dataQuality(): Promise<QualityReport> {
  const [c] = await query<{ raw: number; rows: number; excluded: number; short: number }>(`
    SELECT (SELECT count(*) FROM plays_raw)::INT AS raw, (SELECT count(*) FROM plays)::INT AS rows,
      (SELECT count(*) FROM plays_raw WHERE coalesce(track_uri, 'local:' || artist || ' — ' || track) IN (SELECT uri FROM excluded))::INT AS excluded,
      (SELECT count(*) FILTER (WHERE NOT counted) FROM plays)::INT AS short`);
  const byYear = await query<QualityReport['byYear'][number]>(`
    SELECT year(day)::INT AS year, count(*)::INT AS plays, avg(skipped::INT) AS "skipRate",
      avg((reason_end = 'avanti')::INT) AS "fwdShare", avg((platform IN ('iOS', 'Android'))::INT) AS "mobileShare",
      avg(shuffle::INT) AS "shuffleShare"
    FROM plays WHERE kind = 'track' GROUP BY 1 ORDER BY 1`);
  const mood = await query<QualityReport['mood'][number]>(`
    WITH t AS (SELECT p.uri, sum(p.minutes) AS mins, any_value(coalesce(m.mood_source, 'nessuno')) AS source
               FROM plays p LEFT JOIN meta m USING (uri) WHERE p.kind = 'track' GROUP BY p.uri)
    SELECT CASE WHEN source = 'llm_rejected' THEN 'nessuno' ELSE source END AS source, count(*)::INT AS tracks, sum(mins) / (SELECT sum(mins) FROM t) AS "minutesShare"
    FROM t GROUP BY 1 ORDER BY 3 DESC`);
  return {
    rawRows: c.raw,
    rows: c.rows,
    duplicatesRemoved: c.raw - c.excluded - c.rows,
    excludedRows: c.excluded,
    short: c.short,
    byYear,
    mood,
  };
}

// SQL schema + derivations. Engine-agnostic: runs on DuckDB-WASM (browser) and @duckdb/node-api (tests).

export const SESSION_GAP_MINUTES = 30;

/** Builds `plays` and `tracks` from `plays_raw` (normalized columns, timestamps as VARCHAR). */
export const BUILD_SQL = /* sql */ `
-- Tracks the user removed from the whole app (filled from IndexedDB before this runs).
CREATE TABLE IF NOT EXISTS excluded (uri VARCHAR, track VARCHAR, artist VARCHAR);
CREATE OR REPLACE TABLE plays AS
WITH base AS (
  SELECT
    CAST(ts_start AS TIMESTAMP)                         AS ts,
    CAST(ts_local AS TIMESTAMP)                         AS tl,
    CAST(CAST(ts_local AS TIMESTAMP) AS DATE)           AS day,
    CAST(ms_played AS BIGINT)                           AS ms_played,
    ms_played / 60000.0                                 AS minutes,
    ms_played >= 30000                                  AS counted,
    coalesce(track_uri, 'local:' || artist || ' — ' || track) AS uri,
    track, artist, album, kind, platform,
    conn_country AS country, reason_start, reason_end,
    shuffle, skipped, offline, incognito
  FROM plays_raw
  WHERE coalesce(track_uri, 'local:' || artist || ' — ' || track) NOT IN (SELECT uri FROM excluded)
),
gaps AS (
  SELECT *,
    CASE
      WHEN lag(ts) OVER w IS NULL THEN 1
      WHEN ts - (lag(ts) OVER w + to_milliseconds(lag(ms_played) OVER w)) > INTERVAL ${SESSION_GAP_MINUTES} MINUTE THEN 1
      ELSE 0
    END AS new_session
  FROM base
  WINDOW w AS (ORDER BY ts)
)
SELECT
  row_number() OVER (ORDER BY ts)                                     AS id,
  *,
  sum(new_session) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING)        AS session_id,
  row_number() OVER (PARTITION BY uri ORDER BY ts) - 1                AS prior_plays,
  hour(tl)                                                            AS hour,
  isodow(tl)                                                          AS dow
FROM gaps;

CREATE OR REPLACE TABLE plays_seq AS
SELECT id, session_id,
  row_number() OVER (PARTITION BY session_id ORDER BY ts) AS pos_in_session,
  lag(uri) OVER (PARTITION BY session_id ORDER BY ts)     AS prev_uri,
  date_diff('day', lag(day) OVER (PARTITION BY uri ORDER BY ts), day) AS days_since_last
FROM plays;

CREATE OR REPLACE TABLE tracks AS
SELECT
  uri,
  arg_max(track, ts)  AS track,
  arg_max(artist, ts) AS artist,
  arg_max(album, ts)  AS album,
  count(*) FILTER (WHERE counted) AS plays,
  count(*)            AS starts,
  sum(minutes)        AS minutes,
  avg(skipped::INT)   AS skip_rate,
  coalesce(max(ms_played) FILTER (WHERE reason_end = 'fine brano'), max(ms_played)) AS duration_ms,
  min(day)            AS first_day,
  max(day)            AS last_day
FROM plays
WHERE kind = 'track'
GROUP BY uri;
`;

/** Per-track enrichment (filled progressively). */
export const META_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (
  uri          VARCHAR PRIMARY KEY,
  cover        VARCHAR,
  valence      DOUBLE,
  energy       DOUBLE,
  danceability DOUBLE,
  tempo        DOUBLE,
  acousticness DOUBLE,
  mood_source  VARCHAR,
  mood_conf    DOUBLE,
  tags         VARCHAR,
  lyrics       VARCHAR,
  cluster      INTEGER,
  x            DOUBLE,
  y            DOUBLE,
  valence_audio  DOUBLE,
  energy_audio   DOUBLE,
  valence_lyrics DOUBLE,
  mood_adj       VARCHAR
);
-- Sessions restored from an older schema: add the mood-adjustment columns in place.
ALTER TABLE meta ADD COLUMN IF NOT EXISTS valence_audio DOUBLE;
ALTER TABLE meta ADD COLUMN IF NOT EXISTS energy_audio DOUBLE;
ALTER TABLE meta ADD COLUMN IF NOT EXISTS valence_lyrics DOUBLE;
ALTER TABLE meta ADD COLUMN IF NOT EXISTS mood_adj VARCHAR;
`;

export const META_COLUMNS = [
  'uri',
  'cover',
  'valence',
  'energy',
  'danceability',
  'tempo',
  'acousticness',
  'mood_source',
  'mood_conf',
  'tags',
  'lyrics',
  'cluster',
  'x',
  'y',
  'valence_audio',
  'energy_audio',
  'valence_lyrics',
  'mood_adj',
] as const;
export type MetaColumn = (typeof META_COLUMNS)[number];
export type MetaRow = { uri: string } & Partial<Record<Exclude<MetaColumn, 'uri'>, string | number | null>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Filtered view used by every screen. Dates are validated (no injection). */
export function filterViewSql(from: string | null, to: string | null): string {
  const conds = [`kind = 'track'`];
  if (from && DATE_RE.test(from)) conds.push(`day >= DATE '${from}'`);
  if (to && DATE_RE.test(to)) conds.push(`day <= DATE '${to}'`);
  return `CREATE OR REPLACE VIEW p AS SELECT p0.*, m.cover, m.valence, m.energy, m.cluster
    FROM plays p0 LEFT JOIN meta m USING (uri) WHERE ${conds.join(' AND ')};`;
}

/** Human description of the schema, given to the LLM agent. */
export const SCHEMA_FOR_LLM = `
Tabelle DuckDB disponibili (SQL dialetto DuckDB):

p  -- VISTA principale: un ascolto per riga, SOLO brani musicali, GIÀ filtrata sul periodo selezionato dall'utente
  id BIGINT, ts TIMESTAMP (UTC inizio), tl TIMESTAMP (ora locale inizio), day DATE (locale),
  ms_played BIGINT, minutes DOUBLE, counted BOOLEAN (true se ascoltato >= 30s: definizione di "ascolto"), uri VARCHAR (id brano), track VARCHAR, artist VARCHAR, album VARCHAR,
  platform VARCHAR ('iOS','Android','Desktop','Web','Altri dispositivi','Altro'), country VARCHAR (ISO2),
  reason_start VARCHAR, reason_end VARCHAR ('fine brano','avanti','indietro','click','stop',...),
  shuffle BOOLEAN, skipped BOOLEAN, offline BOOLEAN, incognito BOOLEAN,
  session_id BIGINT (sessione = gap > 30 min), prior_plays BIGINT (ascolti precedenti dello stesso brano),
  hour INT (0-23 locale), dow INT (1=lunedì..7=domenica),
  cover VARCHAR, valence DOUBLE (0-1, positività), energy DOUBLE (0-1, arousal), cluster INT

plays -- come p ma SENZA filtro periodo e include anche podcast/audiolibri (colonna kind: 'track'|'episode'|'audiobook')

tracks -- un brano per riga, su TUTTO lo storico
  uri, track, artist, album, plays BIGINT (ascolti >= 30s), starts BIGINT, minutes DOUBLE, skip_rate DOUBLE, duration_ms BIGINT, first_day DATE, last_day DATE

meta -- arricchimento per brano: uri, cover, valence, energy, danceability, tempo, acousticness, mood_source, mood_conf, tags (CSV), cluster, x, y

clusters -- id INTEGER, label VARCHAR (nome del cluster musicale)

Note: "tempo di ascolto" = sum(minutes). "Ascolti" = count(*) FILTER (WHERE counted). Tasso di skip = avg(skipped::INT). Usa sempre p per domande sul periodo corrente.
`;

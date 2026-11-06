// Data for the extra PDF pages (ReportExtra.tsx): same functions as the app pages.
import { query } from '../../data/db';
import { artistSurvival, detectEras, rediscoveryCandidates, sessionStats, trainSkipModel, type Candidate, type Era, type SessionStats, type SkipModelResult, type Survival } from '../../ml/models';
import { genreLandmarks, mapAxes, type AxisReading } from '../../ml/mapAxes';

export interface ExtraData {
  daily: Array<{ day: string; minutes: number }>;
  moodMonthly: Array<{ ym: string; valence: number | null; energy: number | null; known: number }>;
  map: {
    points: Array<{ x: number; y: number; cluster: number; minutes: number }>;
    clusters: Array<{ id: number; label: string; minutes: number; tracks: number; artists: string }>;
    landmarks: Array<{ x: number; y: number; text: string }>;
    axes: { x: AxisReading | null; y: AxisReading | null };
  } | null;
  eras: Era[];
  survival: Survival | null;
  rediscovery: Candidate[];
  skip: SkipModelResult | null;
  sessions: SessionStats | null;
}

const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    console.warn('report: sezione non disponibile', e);
    return fallback;
  }
};

export async function loadExtra(): Promise<ExtraData> {
  const [daily, moodMonthly, mapRows, clusters, eras, survival, rediscovery, skip, sessions] = await Promise.all([
    query<{ day: string; minutes: number }>(`SELECT day::VARCHAR AS day, sum(minutes) AS minutes FROM p GROUP BY day ORDER BY day`),
    query<{ ym: string; valence: number | null; energy: number | null; known: number }>(`
      SELECT strftime(day, '%Y-%m') AS ym,
        sum(valence * minutes) FILTER (WHERE valence IS NOT NULL) / nullif(sum(minutes) FILTER (WHERE valence IS NOT NULL), 0) AS valence,
        sum(energy * minutes) FILTER (WHERE energy IS NOT NULL) / nullif(sum(minutes) FILTER (WHERE energy IS NOT NULL), 0) AS energy,
        sum(minutes) FILTER (WHERE valence IS NOT NULL) / sum(minutes) AS known
      FROM p GROUP BY 1 ORDER BY 1`),
    safe(
      query<{ x: number; y: number; cluster: number; minutes: number; valence: number | null; energy: number | null; danceability: number | null; acousticness: number | null; year: number | null; tags: string | null }>(`
        SELECT m.x, m.y, coalesce(m.cluster, 0) AS cluster, t.minutes, m.valence, m.energy, m.danceability, m.acousticness, year(t.first_day) AS year, m.tags
        FROM tracks t JOIN meta m USING (uri) WHERE m.x IS NOT NULL`),
      [],
    ),
    safe(
      query<{ id: number; label: string; minutes: number; tracks: number; artists: string }>(`
        WITH r AS (
          SELECT m.cluster, t.artist, sum(t.minutes) AS minutes, count(*) AS n,
            row_number() OVER (PARTITION BY m.cluster ORDER BY sum(t.minutes) DESC) AS rn
          FROM tracks t JOIN meta m USING (uri) WHERE m.cluster IS NOT NULL GROUP BY m.cluster, t.artist)
        SELECT c.id, c.label, sum(r.minutes)::DOUBLE AS minutes, sum(r.n)::INTEGER AS tracks,
          string_agg(r.artist, ', ' ORDER BY r.minutes DESC) FILTER (WHERE r.rn <= 4) AS artists
        FROM clusters c JOIN r ON r.cluster = c.id GROUP BY c.id, c.label ORDER BY minutes DESC`),
      [],
    ),
    safe(detectEras(7), []),
    safe(artistSurvival(90), null as Survival | null),
    safe(rediscoveryCandidates(10), []),
    safe(trainSkipModel({ permutations: 4 }), null),
    safe(sessionStats(), null),
  ]);
  const map = mapRows.length
    ? {
        points: mapRows.map((r) => ({ x: r.x, y: r.y, cluster: r.cluster, minutes: r.minutes })),
        clusters,
        landmarks: genreLandmarks(mapRows, 8),
        axes: mapAxes(mapRows),
      }
    : null;
  return { daily, moodMonthly, map, eras, survival, rediscovery, skip, sessions };
}

/** Spotify end reasons as readable Italian (raw codes from the export otherwise). */
export function reasonLabel(code: string): string {
  const m: Record<string, string> = {
    'unexpected-exit-while-paused': 'app chiusa in pausa',
    'unexpected-exit': 'app chiusa',
    unknown: 'sconosciuto',
    remoto: 'da un altro dispositivo',
    errore: 'errore di riproduzione',
    endplay: 'fine riproduzione',
    '—': 'non registrato',
  };
  return m[code] ?? code;
}


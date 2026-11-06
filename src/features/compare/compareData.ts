// Comparison between the open analysis ("tu") and another saved analysis (a friend). The other person's full
// history is loaded into scratch DuckDB tables (o_raw → o); mood/genres come from their own enrichment, then
// the shared catalog, then yours — so no new network call is needed for songs anyone already looked up.
import { exec, loadIpcTable, loadRowsTable, playsIpc, query } from '../../data/db';
import { parseExport } from '../../data/import';
import { analyses, type Analysis } from '../../lib/analyses';
import { readCatalog } from '../../lib/catalogCache';
import { kvFor } from '../../lib/kv';
import { MOOD_SQL, type Mood } from '../../lib/mood';
import { useApp } from '../../lib/store';

// ---------- adding a person ----------

/** Creates a saved analysis for another person from their ZIP, without switching to it. */
export async function importPerson(name: string, files: File[], onStep: (s: string) => void): Promise<Analysis> {
  const res = await parseExport(files, useApp.getState().settings.timeZone, onStep);
  if (!res.stats.rows || res.historyKind === 'none') throw new Error('In questi file non c’è una cronologia di ascolto.');
  const title = name.trim() || res.profile?.displayName || res.profile?.username || '';
  if (!title) throw new Error('Scrivi il nome della persona.');
  onStep('Salvo nel database…');
  const a = await analyses.create(title);
  try {
    const store = kvFor(a.id);
    await store.setMany([
      ['plays_ipc', playsIpc(res.cols)],
      ['dataset', { historyKind: res.historyKind, rows: res.stats.rows }],
      ...(res.profile ? ([['profile', res.profile]] as Array<[string, unknown]>) : []),
    ]);
    const days = res.cols.ts_local.map((s) => s.slice(0, 10)).sort();
    return await analyses.update(a.id, {
      history_kind: res.historyKind,
      rows: res.stats.rows,
      first_day: days[0] ?? null,
      last_day: days[days.length - 1] ?? null,
      display_name: res.profile?.displayName ?? res.profile?.username ?? null,
    });
  } catch (e) {
    await analyses.remove(a.id).catch(() => undefined);
    throw e;
  }
}

// ---------- loading the other person into DuckDB ----------

const ME = `(SELECT tl, day, minutes, counted, uri, track, artist, album, platform, reason_end, shuffle, skipped, hour, dow, ts FROM plays WHERE kind = 'track')`;

let loaded: { id: string; p: Promise<void> } | null = null;

/** One load per person: concurrent callers share it (two loads at once would drop each other's scratch tables). */
export function loadOther(id: string, onStep: (s: string) => void = () => {}): Promise<void> {
  if (loaded?.id === id) return loaded.p;
  const prev = loaded?.p ?? Promise.resolve();
  const p = prev.catch(() => undefined).then(() => loadOtherNow(id, onStep));
  loaded = { id, p };
  p.catch(() => {
    if (loaded?.p === p) loaded = null;
  });
  return p;
}

async function loadOtherNow(id: string, onStep: (s: string) => void): Promise<void> {
  const store = kvFor(id);
  onStep('Carico il suo storico dal database…');
  const ipc = await store.get<Uint8Array>('plays_ipc');
  if (!ipc) throw new Error('Questa analisi non ha uno storico salvato.');
  await loadIpcTable(ipc, 'o_raw');
  await exec(`
    CREATE OR REPLACE TABLE o AS
    SELECT CAST(ts_start AS TIMESTAMP) AS ts, CAST(ts_local AS TIMESTAMP) AS tl, CAST(CAST(ts_local AS TIMESTAMP) AS DATE) AS day,
      ms_played / 60000.0 AS minutes, ms_played >= 30000 AS counted,
      coalesce(track_uri, 'local:' || artist || ' — ' || track) AS uri, track, artist, album, platform, reason_end, shuffle, skipped,
      hour(CAST(ts_local AS TIMESTAMP)) AS hour, isodow(CAST(ts_local AS TIMESTAMP)) AS dow
    FROM o_raw WHERE kind = 'track'
    QUALIFY row_number() OVER (PARTITION BY ts_start, coalesce(track_uri, 'local:' || artist || ' — ' || track) ORDER BY ms_played DESC) = 1;
    DROP TABLE o_raw;`);
  onStep('Recupero mood e generi già noti…');
  // Their own enrichment, if that analysis was ever opened…
  const metaIpc = await store.get<Uint8Array>('meta_ipc');
  if (metaIpc?.length) await loadIpcTable(metaIpc, 'o_meta');
  else await exec(`CREATE OR REPLACE TABLE o_meta (uri VARCHAR, valence DOUBLE, energy DOUBLE, tags VARCHAR, cover VARCHAR)`);
  // …then the shared catalog for their songs that neither of you has in meta.
  const missing = await query<{ uri: string }>(`
    SELECT DISTINCT o.uri FROM o
    WHERE o.uri LIKE 'spotify:track:%' AND o.uri NOT IN (SELECT uri FROM meta WHERE valence IS NOT NULL OR tags IS NOT NULL)
      AND o.uri NOT IN (SELECT uri FROM o_meta)`);
  const cat = await readCatalog(missing.map((m) => m.uri));
  await loadRowsTable(
    cat.map((c) => ({ uri: c.uri, valence: (c.valence as number) ?? null, energy: (c.energy as number) ?? null, tags: (c.tags as string) ?? null, cover: (c.cover as string) ?? null })),
    ['uri', 'valence', 'energy', 'tags', 'cover'],
    'o_cat',
  ).catch(() => exec(`CREATE OR REPLACE TABLE o_cat (uri VARCHAR, valence DOUBLE, energy DOUBLE, tags VARCHAR, cover VARCHAR)`));
  await exec(`
    CREATE OR REPLACE TABLE cmeta AS
    WITH u AS (
      SELECT uri, valence, energy, tags, cover, 1 AS pr FROM meta
      UNION ALL SELECT uri, valence, energy, tags, cover, 2 FROM o_meta
      UNION ALL SELECT uri, CAST(valence AS DOUBLE), CAST(energy AS DOUBLE), CAST(tags AS VARCHAR), CAST(cover AS VARCHAR), 3 FROM o_cat)
    SELECT uri,
      arg_min(valence, pr) FILTER (WHERE valence IS NOT NULL) AS valence,
      arg_min(energy, pr) FILTER (WHERE energy IS NOT NULL) AS energy,
      arg_min(tags, pr) FILTER (WHERE tags IS NOT NULL AND tags <> '') AS tags,
      arg_min(cover, pr) FILTER (WHERE cover IS NOT NULL AND cover <> '') AS cover
    FROM u GROUP BY uri;`);
}

// ---------- the comparison ----------

export interface Side {
  hours: number;
  from: string;
  to: string;
  artists: number;
  tracks: number;
  hoursPerActiveDay: number;
  weekend: number;
  night: number;
  skip: number;
  shuffle: number;
  sessionMin: number;
  peakHour: number;
  topDevice: string;
  top10Share: number;
  novelty: number;
  moodKnown: number;
  valence: number | null;
  energy: number | null;
}

/** Bump when the Comparison shape changes: older saved comparisons are recomputed. */
export const COMPARE_VERSION = 2;

export interface TopItem {
  label: string;
  sub?: string;
  hours: number;
  cover: string | null;
}

export interface Records {
  streak: { days: number; from: string; to: string } | null;
  topDay: { day: string; hours: number } | null;
  topTrack: { track: string; artist: string; hours: number; cover: string | null } | null;
  topMonth: { ym: string; hours: number } | null;
  happiestYear: { year: number; valence: number } | null;
}

export interface Comparison {
  v: number;
  topArtists: { me: TopItem[]; them: TopItem[] };
  topTracks: { me: TopItem[]; them: TopItem[] };
  yearsDetail: Array<{ year: number; me: string | null; them: string | null; meH: number; themH: number; shared: boolean }>;
  records: { me: Records; them: Records };
  sync: { days: number; tracks: number; examples: Array<{ day: string; track: string; artist: string; cover: string | null }>; sameArtistDays: number };
  score: number;
  parts: Array<{ key: string; label: string; value: number; weight: number; desc: string }>;
  me: Side;
  them: Side;
  overlap: { from: string; to: string } | null;
  byYear: Array<{ year: number; affinity: number; meH: number; themH: number }>;
  firstFound: { meFirst: number; themFirst: number; same: number; examples: Array<{ artist: string; me: string; them: string; leadDays: number }> };
  sharedArtists: Array<{ artist: string; me: number; them: number }>;
  theirGems: Array<{ artist: string; minutes: number }>;
  myGems: Array<{ artist: string; minutes: number }>;
  sharedTracks: Array<{ uri: string; track: string; artist: string; cover: string | null; me: number; them: number }>;
  theirTracks: Array<{ uri: string; track: string; artist: string; cover: string | null; minutes: number }>;
  tags: { me: Array<[string, number]>; them: Array<[string, number]>; shared: string[] };
  moodMix: Array<{ mood: Mood; me: number; them: number }>;
  moodMonthly: Array<{ ym: string; me: number | null; them: number | null }>;
  hours24: Array<{ hour: number; me: number; them: number }>;
}

const sqrtCos = (a: Map<string, number>, b: Map<string, number>) => {
  const ta = [...a.values()].reduce((s, v) => s + v, 0) || 1;
  const tb = [...b.values()].reduce((s, v) => s + v, 0) || 1;
  let dot = 0;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) dot += Math.sqrt((v / ta) * (w / tb));
  }
  return dot; // Σ sqrt(pa·pb) = Bhattacharyya coefficient, 0..1
};

const cosine = (a: number[], b: number[]) => {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

async function side(src: string, meta: string): Promise<Side> {
  const [k] = await query<Side & { from: string; to: string }>(`
    WITH x AS (SELECT * FROM ${src}),
    s AS (
      SELECT minutes, CASE WHEN lag(tl) OVER w IS NULL OR tl - lag(tl) OVER w > INTERVAL 30 MINUTE + to_milliseconds(CAST(lag(minutes) OVER w * 60000 AS BIGINT)) THEN 1 ELSE 0 END AS ns
      FROM x WINDOW w AS (ORDER BY tl)),
    sess AS (SELECT sum(ns) AS n, sum(minutes) AS m FROM s),
    firsts AS (SELECT uri, min(day) AS d FROM x GROUP BY uri),
    top10 AS (SELECT sum(m) AS m FROM (SELECT sum(minutes) AS m FROM x GROUP BY artist ORDER BY m DESC LIMIT 10))
    SELECT sum(minutes) / 60 AS hours, min(day)::VARCHAR AS "from", max(day)::VARCHAR AS "to",
      count(DISTINCT artist) FILTER (WHERE counted) AS artists, count(DISTINCT uri) FILTER (WHERE counted) AS tracks,
      sum(minutes) / 60 / count(DISTINCT day) AS hoursPerActiveDay,
      sum(minutes) FILTER (WHERE dow >= 6) / sum(minutes) AS weekend,
      sum(minutes) FILTER (WHERE hour < 5) / sum(minutes) AS night,
      avg(CASE WHEN reason_end = 'avanti' THEN 1 ELSE 0 END) AS skip,
      avg(shuffle::INT) AS shuffle,
      (SELECT m / greatest(n, 1) FROM sess) AS sessionMin,
      (SELECT hour FROM x GROUP BY hour ORDER BY sum(minutes) DESC LIMIT 1) AS peakHour,
      (SELECT platform FROM x GROUP BY platform ORDER BY sum(minutes) DESC LIMIT 1) AS topDevice,
      (SELECT m FROM top10) / sum(minutes) AS top10Share,
      sum(x.minutes) FILTER (WHERE date_trunc('month', x.day) = date_trunc('month', f.d)) / sum(x.minutes) AS novelty,
      sum(x.minutes) FILTER (WHERE c.valence IS NOT NULL) / sum(x.minutes) AS moodKnown,
      sum(c.valence * x.minutes) / nullif(sum(x.minutes) FILTER (WHERE c.valence IS NOT NULL), 0) AS valence,
      sum(c.energy * x.minutes) / nullif(sum(x.minutes) FILTER (WHERE c.energy IS NOT NULL), 0) AS energy
    FROM x LEFT JOIN firsts f USING (uri) LEFT JOIN ${meta} c USING (uri)`);
  return k;
}

export async function compareWith(theirName: string): Promise<Comparison> {
  void theirName;
  const [me, them] = await Promise.all([side(ME, 'cmeta'), side('o', 'cmeta')]);
  const ov = me.from && them.from ? { from: me.from > them.from ? me.from : them.from, to: me.to < them.to ? me.to : them.to } : null;
  const overlap = ov && ov.from <= ov.to ? ov : null;

  // Artists (whole histories).
  const [aMe, aThem] = await Promise.all([
    query<{ artist: string; m: number }>(`SELECT artist, sum(minutes) AS m FROM ${ME} GROUP BY 1 ORDER BY 2 DESC`),
    query<{ artist: string; m: number }>(`SELECT artist, sum(minutes) AS m FROM o GROUP BY 1 ORDER BY 2 DESC`),
  ]);
  const A = new Map(aMe.map((r) => [r.artist, r.m]));
  const B = new Map(aThem.map((r) => [r.artist, r.m]));
  const totA = aMe.reduce((s, r) => s + r.m, 0) || 1;
  const totB = aThem.reduce((s, r) => s + r.m, 0) || 1;
  const artistAff = sqrtCos(A, B);
  const sharedArtists = aMe
    .filter((r) => B.has(r.artist))
    .map((r) => ({ artist: r.artist, me: r.m, them: B.get(r.artist)! }))
    .sort((x, y) => Math.min(y.me / totA, y.them / totB) - Math.min(x.me / totA, x.them / totB))
    .slice(0, 12);
  const theirGems = aThem.filter((r) => (A.get(r.artist) ?? 0) < 5).slice(0, 10).map((r) => ({ artist: r.artist, minutes: r.m }));
  const myGems = aMe.filter((r) => (B.get(r.artist) ?? 0) < 5).slice(0, 10).map((r) => ({ artist: r.artist, minutes: r.m }));

  // Tracks: overlap coefficient Σ min(share) and the lists.
  const [tMe, tThem] = await Promise.all([
    query<{ uri: string; track: string; artist: string; m: number }>(`SELECT uri, any_value(track) AS track, any_value(artist) AS artist, sum(minutes) AS m FROM ${ME} GROUP BY uri`),
    query<{ uri: string; track: string; artist: string; m: number }>(`SELECT uri, any_value(track) AS track, any_value(artist) AS artist, sum(minutes) AS m FROM o GROUP BY uri`),
  ]);
  const TA = new Map(tMe.map((r) => [r.uri, r.m]));
  const TB = new Map(tThem.map((r) => [r.uri, r.m]));
  const ttA = tMe.reduce((s, r) => s + r.m, 0) || 1;
  const ttB = tThem.reduce((s, r) => s + r.m, 0) || 1;
  let trackOverlap = 0;
  for (const [u, m] of TA) {
    const w = TB.get(u);
    if (w) trackOverlap += Math.min(m / ttA, w / ttB);
  }
  const covers = new Map(
    (await query<{ uri: string; cover: string | null }>(`SELECT uri, cover FROM cmeta WHERE cover IS NOT NULL`)).map((r) => [r.uri, r.cover]),
  );
  const sharedTracks = tMe
    .filter((r) => TB.has(r.uri))
    .map((r) => ({ uri: r.uri, track: r.track, artist: r.artist, cover: covers.get(r.uri) ?? null, me: r.m, them: TB.get(r.uri)! }))
    .sort((x, y) => Math.min(y.me / ttA, y.them / ttB) - Math.min(x.me / ttA, x.them / ttB))
    .slice(0, 12);
  const theirTracks = tThem
    .filter((r) => !TA.has(r.uri) && !A.has(r.artist))
    .sort((x, y) => y.m - x.m)
    .slice(0, 12)
    .map((r) => ({ uri: r.uri, track: r.track, artist: r.artist, cover: covers.get(r.uri) ?? null, minutes: r.m }));

  // Genres from tags (weighted by listening time).
  const tagSql = (src: string) => `
    SELECT lower(trim(t)) AS tag, sum(x.minutes) AS m FROM ${src} x JOIN cmeta c USING (uri), unnest(string_split(c.tags, ',')) AS u(t)
    WHERE c.tags IS NOT NULL AND trim(t) <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 300`;
  const [gMe, gThem] = await Promise.all([query<{ tag: string; m: number }>(tagSql(ME)), query<{ tag: string; m: number }>(tagSql('o'))]);
  const GA = new Map(gMe.map((r) => [r.tag, r.m]));
  const GB = new Map(gThem.map((r) => [r.tag, r.m]));
  const genreAff = GA.size && GB.size ? sqrtCos(GA, GB) : null;
  const gTotA = gMe.reduce((s, r) => s + r.m, 0) || 1;
  const gTotB = gThem.reduce((s, r) => s + r.m, 0) || 1;
  const tags = {
    me: gMe.slice(0, 12).map((r) => [r.tag, r.m / gTotA] as [string, number]),
    them: gThem.slice(0, 12).map((r) => [r.tag, r.m / gTotB] as [string, number]),
    shared: gMe.filter((r) => GB.has(r.tag)).slice(0, 30).map((r) => r.tag).filter((t) => (GA.get(t)! / gTotA) > 0.005 && (GB.get(t)! / gTotB) > 0.005).slice(0, 12),
  };

  // Mood mix + monthly valence.
  const moodSql = (src: string) => `SELECT ${MOOD_SQL('c.valence', 'c.energy')} AS mood, sum(x.minutes) AS m FROM ${src} x LEFT JOIN cmeta c USING (uri) GROUP BY 1`;
  const [mMe, mThem] = await Promise.all([query<{ mood: Mood; m: number }>(moodSql(ME)), query<{ mood: Mood; m: number }>(moodSql('o'))]);
  const known = (rows: Array<{ mood: Mood; m: number }>) => rows.filter((r) => r.mood !== 'sconosciuto');
  const kMe = known(mMe);
  const kThem = known(mThem);
  const sMe = kMe.reduce((s, r) => s + r.m, 0) || 1;
  const sThem = kThem.reduce((s, r) => s + r.m, 0) || 1;
  const moods = [...new Set([...kMe, ...kThem].map((r) => r.mood))];
  const moodMix = moods
    .map((mood) => ({ mood, me: (kMe.find((r) => r.mood === mood)?.m ?? 0) / sMe, them: (kThem.find((r) => r.mood === mood)?.m ?? 0) / sThem }))
    .sort((a, b) => b.me + b.them - (a.me + a.them));
  const moodAff = kMe.length && kThem.length ? 1 - moodMix.reduce((s, r) => s + Math.abs(r.me - r.them), 0) / 2 : null;
  const monthSql = (src: string) => `
    SELECT strftime(x.day, '%Y-%m') AS ym, sum(c.valence * x.minutes) / nullif(sum(x.minutes) FILTER (WHERE c.valence IS NOT NULL), 0) AS v,
      sum(x.minutes) FILTER (WHERE c.valence IS NOT NULL) / sum(x.minutes) AS k
    FROM ${src} x LEFT JOIN cmeta c USING (uri) GROUP BY 1`;
  const [vMe, vThem] = await Promise.all([query<{ ym: string; v: number | null; k: number }>(monthSql(ME)), query<{ ym: string; v: number | null; k: number }>(monthSql('o'))]);
  const VM = new Map(vMe.filter((r) => r.k >= 0.3).map((r) => [r.ym, r.v]));
  const VT = new Map(vThem.filter((r) => r.k >= 0.3).map((r) => [r.ym, r.v]));
  const moodMonthly = [...new Set([...VM.keys(), ...VT.keys()])]
    .sort()
    .filter((ym) => !overlap || (ym >= overlap.from.slice(0, 7) && ym <= overlap.to.slice(0, 7)))
    .map((ym) => ({ ym, me: VM.get(ym) ?? null, them: VT.get(ym) ?? null }));

  // Habits: 7×24 weekly rhythm and the 24-hour profile.
  const rhythmSql = (src: string) => `SELECT dow, hour, sum(minutes) AS m FROM ${src} GROUP BY ALL`;
  const [rMe, rThem] = await Promise.all([query<{ dow: number; hour: number; m: number }>(rhythmSql(ME)), query<{ dow: number; hour: number; m: number }>(rhythmSql('o'))]);
  const vec = (rows: Array<{ dow: number; hour: number; m: number }>) => {
    const v = new Array(168).fill(0);
    for (const r of rows) v[(r.dow - 1) * 24 + r.hour] += r.m;
    return v;
  };
  const vm = vec(rMe);
  const vt = vec(rThem);
  const habitAff = cosine(vm, vt);
  const h24 = (v: number[]) => {
    const t = v.reduce((s, x) => s + x, 0) || 1;
    return Array.from({ length: 24 }, (_, h) => [0, 1, 2, 3, 4, 5, 6].reduce((s, d) => s + v[d * 24 + h], 0) / t);
  };
  const hm = h24(vm);
  const ht = h24(vt);
  const hours24 = hm.map((me, hour) => ({ hour, me, them: ht[hour] }));

  // Periods: affinity year by year (same calendar year), and who found shared artists first.
  const yearSql = (src: string) => `SELECT year(day) AS y, artist, sum(minutes) AS m FROM ${src} GROUP BY ALL`;
  const [yMe, yThem] = await Promise.all([query<{ y: number; artist: string; m: number }>(yearSql(ME)), query<{ y: number; artist: string; m: number }>(yearSql('o'))]);
  const years = [...new Set(yMe.map((r) => r.y))].filter((y) => yThem.some((r) => r.y === y)).sort((a, b) => a - b);
  const byYear = years
    .map((y) => {
      const a = new Map(yMe.filter((r) => r.y === y).map((r) => [r.artist, r.m]));
      const b = new Map(yThem.filter((r) => r.y === y).map((r) => [r.artist, r.m]));
      const meH = [...a.values()].reduce((s, v) => s + v, 0) / 60;
      const themH = [...b.values()].reduce((s, v) => s + v, 0) / 60;
      return { year: y, affinity: sqrtCos(a, b), meH, themH };
    })
    .filter((r) => r.meH >= 10 && r.themH >= 10);

  const ff = await query<{ artist: string; me: string; them: string; lead: number }>(`
    WITH a AS (SELECT artist, min(day) AS d, sum(minutes) AS m FROM ${ME} WHERE counted GROUP BY artist),
         b AS (SELECT artist, min(day) AS d, sum(minutes) AS m FROM o WHERE counted GROUP BY artist),
         lim AS (SELECT greatest((SELECT min(day) FROM ${ME}), (SELECT min(day) FROM o)) AS start)
    SELECT a.artist, a.d::VARCHAR AS me, b.d::VARCHAR AS them, date_diff('day', a.d, b.d) AS lead
    FROM a JOIN b USING (artist), lim
    -- Both must really listen to it, and both first plays after the later start of the two histories (else "first" is unknown).
    WHERE a.m >= 60 AND b.m >= 60 AND a.d > lim.start + 30 AND b.d > lim.start + 30
    ORDER BY least(a.m, b.m) DESC LIMIT 400`);
  const firstFound = {
    meFirst: ff.filter((r) => r.lead > 30).length,
    themFirst: ff.filter((r) => r.lead < -30).length,
    same: ff.filter((r) => Math.abs(r.lead) <= 30).length,
    examples: ff.filter((r) => Math.abs(r.lead) > 30).slice(0, 10).map((r) => ({ artist: r.artist, me: r.me, them: r.them, leadDays: r.lead })),
  };

  const parts = [
    { key: 'artists', label: 'Artisti', value: artistAff, weight: 0.3, desc: 'quanto si sovrappone il tempo che date agli stessi artisti' },
    ...(genreAff != null ? [{ key: 'genres', label: 'Generi', value: genreAff, weight: 0.25, desc: 'stessa cosa sui tag di genere dei brani' }] : []),
    { key: 'tracks', label: 'Brani', value: Math.min(1, trackOverlap * 3), weight: 0.15, desc: 'quota di ascolto sugli stessi brani (×3, satura a 100)' },
    ...(moodAff != null ? [{ key: 'mood', label: 'Mood', value: moodAff, weight: 0.15, desc: 'quanto coincide il mix euforico/sereno/teso/malinconico' }] : []),
    { key: 'habits', label: 'Abitudini', value: habitAff, weight: 0.15, desc: 'quando ascoltate: profilo ora × giorno della settimana' },
  ];
  const wsum = parts.reduce((s, p) => s + p.weight, 0);
  const score = Math.round((100 * parts.reduce((s, p) => s + p.value * p.weight, 0)) / wsum);

  // Tops, years, records, "in sync" days.
  const topArtistsSql = (src: string) => `
    SELECT x.artist AS label, sum(x.minutes) / 60 AS hours, arg_max(c.cover, x.minutes) FILTER (WHERE c.cover IS NOT NULL) AS cover
    FROM ${src} x LEFT JOIN cmeta c USING (uri) GROUP BY 1 ORDER BY 2 DESC LIMIT 10`;
  const topTracksSql = (src: string) => `
    SELECT any_value(x.track) AS label, any_value(x.artist) AS sub, sum(x.minutes) / 60 AS hours, any_value(c.cover) AS cover
    FROM ${src} x LEFT JOIN cmeta c USING (uri) GROUP BY x.uri ORDER BY 3 DESC LIMIT 10`;
  const [taMe, taThem, ttMe, ttThem] = await Promise.all([
    query<TopItem>(topArtistsSql(ME)),
    query<TopItem>(topArtistsSql('o')),
    query<TopItem>(topTracksSql(ME)),
    query<TopItem>(topTracksSql('o')),
  ]);
  const topOf = (rows: Array<{ y: number; artist: string; m: number }>, y: number) => {
    let best: { artist: string; m: number } | null = null;
    for (const r of rows) if (r.y === y && (!best || r.m > best.m)) best = r;
    return best;
  };
  const allYears = [...new Set([...yMe.map((r) => r.y), ...yThem.map((r) => r.y)])].sort((a, b) => a - b);
  const yearsDetail = allYears.map((y) => {
    const a = topOf(yMe, y);
    const b = topOf(yThem, y);
    const meH = yMe.filter((r) => r.y === y).reduce((s, r) => s + r.m, 0) / 60;
    const themH = yThem.filter((r) => r.y === y).reduce((s, r) => s + r.m, 0) / 60;
    return { year: y, me: a?.artist ?? null, them: b?.artist ?? null, meH, themH, shared: !!a && !!b && a.artist === b.artist };
  });

  const recordsOf = async (src: string): Promise<Records> => {
    const [streak] = await query<{ days: number; from: string; to: string }>(`
      WITH d AS (SELECT DISTINCT day FROM ${src}), g AS (SELECT day, day - CAST(row_number() OVER (ORDER BY day) AS INTEGER) AS grp FROM d)
      SELECT count(*) AS days, min(day)::VARCHAR AS "from", max(day)::VARCHAR AS "to" FROM g GROUP BY grp ORDER BY days DESC LIMIT 1`);
    // Days over 24 h exist in exports (plays overlapping on two devices): not a real record, skipped.
    const [topDay] = await query<{ day: string; hours: number }>(
      `SELECT day::VARCHAR AS day, sum(minutes) / 60 AS hours FROM ${src} GROUP BY day HAVING sum(minutes) <= 1440 ORDER BY 2 DESC LIMIT 1`,
    );
    const [topMonth] = await query<{ ym: string; hours: number }>(`SELECT strftime(day, '%Y-%m') AS ym, sum(minutes) / 60 AS hours FROM ${src} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
    const [happy] = await query<{ year: number; valence: number }>(`
      SELECT year(x.day) AS year, sum(c.valence * x.minutes) / sum(x.minutes) AS valence FROM ${src} x JOIN cmeta c USING (uri)
      WHERE c.valence IS NOT NULL GROUP BY 1 HAVING sum(x.minutes) > 600 ORDER BY 2 DESC LIMIT 1`);
    const t = (src === 'o' ? ttThem : ttMe)[0];
    return {
      streak: streak ?? null,
      topDay: topDay ?? null,
      topMonth: topMonth ?? null,
      happiestYear: happy ?? null,
      topTrack: t ? { track: t.label, artist: t.sub ?? '', hours: t.hours, cover: t.cover } : null,
    };
  };
  const [recMe, recThem] = await Promise.all([recordsOf(ME), recordsOf('o')]);

  const [syncN] = await query<{ days: number; tracks: number }>(`
    WITH a AS (SELECT DISTINCT day, uri FROM ${ME} WHERE counted), b AS (SELECT DISTINCT day, uri FROM o WHERE counted)
    SELECT count(DISTINCT day) AS days, count(DISTINCT uri) AS tracks FROM a JOIN b USING (day, uri)`);
  const syncEx = await query<{ day: string; track: string; artist: string; cover: string | null }>(`
    WITH a AS (SELECT DISTINCT day, uri FROM ${ME} WHERE counted), b AS (SELECT DISTINCT day, uri FROM o WHERE counted),
    j AS (SELECT day, uri FROM a JOIN b USING (day, uri)),
    t AS (SELECT uri, any_value(track) AS track, any_value(artist) AS artist FROM ${ME} GROUP BY uri)
    SELECT j.day::VARCHAR AS day, t.track, t.artist, c.cover FROM j JOIN t USING (uri) LEFT JOIN cmeta c USING (uri)
    QUALIFY row_number() OVER (PARTITION BY j.uri ORDER BY j.day) = 1
    ORDER BY j.day DESC LIMIT 8`);
  const [sameArtist] = await query<{ n: number }>(`
    WITH a AS (SELECT DISTINCT day, artist FROM ${ME} WHERE counted), b AS (SELECT DISTINCT day, artist FROM o WHERE counted)
    SELECT count(DISTINCT day) AS n FROM a JOIN b USING (day, artist)`);

  return {
    v: COMPARE_VERSION,
    topArtists: { me: taMe, them: taThem },
    topTracks: { me: ttMe, them: ttThem },
    yearsDetail,
    records: { me: recMe, them: recThem },
    sync: { days: syncN?.days ?? 0, tracks: syncN?.tracks ?? 0, examples: syncEx, sameArtistDays: sameArtist?.n ?? 0 },
    score,
    parts,
    me,
    them,
    overlap,
    byYear,
    firstFound,
    sharedArtists,
    theirGems,
    myGems,
    sharedTracks,
    theirTracks,
    tags,
    moodMix,
    moodMonthly,
    hours24,
  };
}

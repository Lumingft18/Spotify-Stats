// Integration tests: every SQL used by the app runs against a real export on @duckdb/node-api.
// Set SPOTIFY_TEST_ZIP=/path/to/export.zip to run (skipped otherwise; personal data never lives in the repo).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createNodeEngine, columnsFromZip, loadColumns, type NodeEngine } from './nodeEngine';

const ZIP = process.env.SPOTIFY_TEST_ZIP ?? '';
const enabled = !!ZIP && existsSync(ZIP);

let engine: NodeEngine;
const kv = new Map<string, unknown>();

vi.mock('../src/data/db', () => ({
  query: (sql: string, params?: unknown[]) => engine.query(sql, params),
  exec: (sql: string) => engine.exec(sql),
  upsertMeta: async () => undefined,
  setClusters: async () => undefined,
}));
vi.mock('../src/lib/kv', () => ({
  kv: {
    get: async (k: string) => kv.get(k),
    set: async (k: string, v: unknown) => void kv.set(k, v),
    setMany: async (e: Array<[string, unknown]>) => e.forEach(([k, v]) => kv.set(k, v)),
    del: async (k: string) => void kv.delete(k),
  },
}));

describe.skipIf(!enabled)('SQL on a real export', () => {
  beforeAll(async () => {
    engine = await createNodeEngine();
    await loadColumns(engine, columnsFromZip(ZIP));
    // Fake enrichment: deterministic pseudo valence/energy + clusters on top tracks.
    await engine.exec(`INSERT INTO meta (uri, cover, valence, energy, mood_source, cluster, x, y)
      SELECT uri, 'https://example.org/c.jpg', (hash(uri) % 1000) / 1000.0, (hash(track) % 1000) / 1000.0, 'reccobeats',
             (hash(artist) % 6)::INT, random(), random()
      FROM tracks ORDER BY minutes DESC LIMIT 1500`);
    await engine.exec(`INSERT INTO clusters SELECT range::INT, 'Gruppo ' || range FROM range(6)`);
    const { filterViewSql } = await import('../src/data/schema');
    await engine.exec(filterViewSql(null, null));
  });

  it('shared queries', async () => {
    const q = await import('../src/data/queries');
    const [k] = await engine.query<{ minutes: number; plays: number }>(q.KPI_SQL);
    expect(k.minutes).toBeGreaterThan(0);
    expect(Number(k.plays)).toBeGreaterThan(0);
    for (const kind of ['artists', 'tracks', 'albums'] as const) {
      expect((await engine.query(q.topSql(kind, 'minutes', 5))).length).toBe(5);
      expect((await engine.query(q.topSql(kind, 'plays', 5, 0, true), ['%a%'])).length).toBeGreaterThan(0);
    }
    expect((await engine.query(q.MONTHLY_SQL)).length).toBeGreaterThan(3);
    expect((await engine.query(q.HOUR_DOW_SQL)).length).toBeGreaterThan(24);
    expect((await engine.query(q.DAILY_SQL)).length).toBeGreaterThan(30);
    const w = await engine.query(q.KPI_WINDOW_SQL, ['2024-01-01', '2024-12-31']);
    expect(w.length).toBe(1);
  });

  it('story/report facts (all years, one year, date range)', async () => {
    const f = await import('../src/data/facts');
    const all = await f.loadFacts(f.yearWhere(0), 0);
    expect(all!.minutes).toBeGreaterThan(0);
    expect(all!.byYear.length).toBeGreaterThan(0);
    expect(all!.streak!.days).toBeGreaterThan(0);
    expect(all!.marathon!.minutes).toBeGreaterThan(0);
    expect(all!.happyDay).not.toBeNull();
    expect(all!.happyDay!.valence).toBeGreaterThanOrEqual(all!.sadDay?.valence ?? 0);
    expect(all!.happyDay!.tracks.length).toBeGreaterThan(0);
    expect(all!.moodMix.reduce((s, m) => s + m.share, 0)).toBeCloseTo(1, 5);
    const y = Number(all!.lastDay.slice(0, 4));
    const one = await f.loadFacts(f.yearWhere(y), y);
    expect(one!.minutes).toBeLessThanOrEqual(all!.minutes);
    const r = await f.loadFacts(f.rangeWhere(`${y}-01-01`, `${y}-12-31`), 0);
    expect(r!.minutes).toBeCloseTo(one!.minutes, 3);
  });

  it('excluded tracks vanish from every derived table', async () => {
    const { BUILD_SQL, filterViewSql } = await import('../src/data/schema');
    const [top] = await engine.query<{ uri: string; plays: number }>(`SELECT uri, plays FROM tracks ORDER BY minutes DESC LIMIT 1`);
    const before = await engine.query<{ n: number }>(`SELECT count(*) AS n FROM plays`);
    await engine.exec(`DELETE FROM excluded; INSERT INTO excluded VALUES ('${top.uri}', 'x', 'y')`);
    await engine.exec(BUILD_SQL);
    await engine.exec(filterViewSql(null, null));
    for (const t of ['plays', 'tracks', 'p']) {
      const [r] = await engine.query<{ n: number }>(`SELECT count(*) AS n FROM ${t} WHERE uri = ?`, [top.uri]);
      expect(r.n).toBe(0);
    }
    const [after] = await engine.query<{ n: number }>(`SELECT count(*) AS n FROM plays`);
    expect(after.n).toBeLessThan(before[0].n);
    await engine.exec(`DELETE FROM excluded`);
    await engine.exec(BUILD_SQL);
    await engine.exec(filterViewSql(null, null));
    const [back] = await engine.query<{ n: number }>(`SELECT count(*) AS n FROM plays`);
    expect(back.n).toBe(before[0].n);
  });

  it('filter view by period', async () => {
    const { filterViewSql } = await import('../src/data/schema');
    await engine.exec(filterViewSql('2024-01-01', '2024-03-31'));
    const [r] = await engine.query<{ a: string; b: string }>(`SELECT min(day)::VARCHAR a, max(day)::VARCHAR b FROM p`);
    expect(r.a >= '2024-01-01' && r.b <= '2024-03-31').toBe(true);
    await engine.exec(filterViewSql(null, null));
  });

  it('insights, eras, sessions, survival', async () => {
    const { computeInsights } = await import('../src/features/overview/insights');
    const ins = await computeInsights();
    expect(ins.length).toBeGreaterThan(0);
    const m = await import('../src/ml/models');
    const eras = await m.detectEras(6);
    expect(eras.length).toBeGreaterThan(1);
    expect(eras[0].topArtists.length).toBeGreaterThan(0);
    const s = await m.sessionStats();
    expect(s.sessions).toBeGreaterThan(10);
    const surv = await m.artistSurvival(90);
    expect(surv.curve.length).toBeGreaterThan(2);
    expect(surv.curve.every((c, i, a) => i === 0 || c.survival <= a[i - 1].survival)).toBe(true);
  });

  it('skip model learns something', async () => {
    const m = await import('../src/ml/models');
    const r = await m.trainSkipModel();
    expect(r).not.toBeNull();
    expect(r!.auc).toBeGreaterThan(0.55);
    expect(r!.effects.length).toBeGreaterThan(5);
    console.log('skip AUC', r!.auc.toFixed(3), r!.effects.slice(0, 3).map((e) => e.sentence));
  });

  it('rediscovery bandit', async () => {
    const m = await import('../src/ml/models');
    const c = await m.rediscoveryCandidates(10, 120);
    expect(c.length).toBeGreaterThan(0);
    await m.rediscoveryFeedback(c[0], true);
    const c2 = await m.rediscoveryCandidates(10, 120);
    expect(c2.find((x) => x.uri === c[0].uri)).toBeUndefined();
  });

  it('cluster labels + mood SQL', async () => {
    const { MOOD_SQL, getMood } = await import('../src/lib/mood');
    const rows = await engine.query<{ valence: number; energy: number; mood: string }>(
      `SELECT valence, energy, ${MOOD_SQL()} mood FROM meta WHERE valence IS NOT NULL LIMIT 300`,
    );
    for (const r of rows) expect(r.mood).toBe(getMood(r.valence, r.energy));
    const e = await import('../src/ml/embeddings');
    await e.labelClusters();
  });

  it('agent example queries are valid', async () => {
    const { safeSql } = await import('../src/llm/agent');
    const qs = [
      `SELECT artist, round(sum(minutes)/60,1) ore FROM p GROUP BY artist ORDER BY ore DESC LIMIT 5`,
      `SELECT strftime(day,'%Y-%m') mese, round(sum(minutes)) minuti FROM p GROUP BY 1 ORDER BY 1`,
      `SELECT dow, round(sum(minutes)/count(DISTINCT day)) minuti_medi FROM p GROUP BY dow ORDER BY dow`,
      `SELECT track, artist, count(*) FILTER (WHERE counted) ascolti FROM p WHERE day BETWEEN DATE '2024-06-21' AND DATE '2024-09-22' GROUP BY ALL ORDER BY ascolti DESC LIMIT 1`,
    ];
    for (const q of qs) expect((await engine.query(safeSql(q))).length).toBeGreaterThan(0);
  });

  it('entity page queries', async () => {
    const [top] = await engine.query<{ artist: string; uri: string; album: string }>(
      `SELECT artist, arg_max(uri, minutes) AS uri FROM tracks GROUP BY artist ORDER BY sum(minutes) DESC LIMIT 1`,
    );
    const a = await engine.query(
      `WITH a AS (SELECT artist, sum(minutes) m FROM p GROUP BY artist),
            r AS (SELECT artist, rank() OVER (ORDER BY m DESC) AS rank, m / sum(m) OVER () AS share FROM a)
       SELECT sum(minutes) AS minutes, any_value(r.rank) AS rank FROM p JOIN r USING (artist) WHERE artist = ?`,
      [top.artist],
    );
    expect(Number((a[0] as { rank: number }).rank)).toBe(1);
    const t = await engine.query(
      `WITH d AS (SELECT day, count(*) FILTER (WHERE counted) n FROM p WHERE uri = ? GROUP BY day)
       SELECT sum(minutes) AS minutes, avg(least(1.0, ms_played / nullif((SELECT duration_ms FROM tracks WHERE uri = ?), 0))) completion,
              (SELECT day::VARCHAR FROM d ORDER BY n DESC LIMIT 1) best_day FROM p WHERE uri = ?`,
      [top.uri, top.uri, top.uri],
    );
    expect((t[0] as { best_day: string }).best_day).toMatch(/^\d{4}-/);
  });
});

// Reproducible analysis report: regenerates every number shown in "Modelli" from a Spotify export,
// with fixed seeds, on native DuckDB. Personal data never enters the repo; output goes to analysis-out/.
//
//   ANALYSIS_ZIP=/path/export.zip npm run analysis
//   ANALYSIS_META=/path/enrichment.json   # optional: enrichment exported from Impostazioni (mood, testi, tag)
//   ANALYSIS_BENCH=1                      # optional: also run the mood benchmark (uses the OpenRouter key
//                                         #           from .env.local; costs a few cents)
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNodeEngine, columnsFromZip, loadColumns, type NodeEngine } from './nodeEngine';

const ZIP = process.env.ANALYSIS_ZIP ?? '';
const META = process.env.ANALYSIS_META ?? '';
const OUT = process.env.ANALYSIS_OUT ?? 'analysis-out';
const enabled = !!ZIP && existsSync(ZIP);

let engine: NodeEngine;
const kv = new Map<string, unknown>();

vi.mock('../src/data/db', () => ({
  query: (sql: string, params?: unknown[]) => engine.query(sql, params),
  exec: (sql: string) => engine.exec(sql),
  upsertMeta: async () => undefined,
  persistMeta: async () => undefined,
  setClusters: async () => undefined,
}));
vi.mock('../src/lib/idb', () => ({
  idb: {
    get: async (k: string) => kv.get(k),
    set: async (k: string, v: unknown) => void kv.set(k, v),
    setMany: async (e: Array<[string, unknown]>) => e.forEach(([k, v]) => kv.set(k, v)),
    del: async (k: string) => void kv.delete(k),
  },
}));

const META_TYPES = {
  uri: 'VARCHAR', cover: 'VARCHAR', valence: 'DOUBLE', energy: 'DOUBLE', danceability: 'DOUBLE', tempo: 'DOUBLE', acousticness: 'DOUBLE',
  mood_source: 'VARCHAR', mood_conf: 'DOUBLE', tags: 'VARCHAR', lyrics: 'VARCHAR', cluster: 'INTEGER', x: 'DOUBLE', y: 'DOUBLE',
  valence_audio: 'DOUBLE', energy_audio: 'DOUBLE', valence_lyrics: 'DOUBLE', mood_adj: 'VARCHAR',
};

const r3 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

describe.skipIf(!enabled)('analysis report', () => {
  beforeAll(async () => {
    engine = await createNodeEngine();
    await loadColumns(engine, columnsFromZip(ZIP));
    if (META && existsSync(META)) {
      const cols = Object.entries(META_TYPES).map(([k, t]) => `${k}: '${t}'`).join(', ');
      // Exports from Impostazioni omit `cover`; missing columns are simply NULL.
      await engine.exec(`INSERT INTO meta BY NAME SELECT * FROM read_json('${resolve(META).replace(/'/g, "''")}', format = 'array', columns = {${cols}})`);
      await engine.exec(`INSERT INTO clusters SELECT DISTINCT cluster, 'Gruppo ' || cluster FROM meta WHERE cluster IS NOT NULL`);
    }
    const { filterViewSql } = await import('../src/data/schema');
    await engine.exec(filterViewSql(null, null));
  });

  it('writes analysis-out/report.json and report.md', async () => {
    const m = await import('../src/ml/models');
    const { dataQuality } = await import('../src/data/quality');
    const [ds] = await engine.query<Record<string, number | string>>(`
      SELECT count(*)::INT AS plays, count(*) FILTER (WHERE counted)::INT AS counted, min(day)::VARCHAR AS first_day, max(day)::VARCHAR AS last_day,
        count(DISTINCT uri)::INT AS tracks, count(DISTINCT artist)::INT AS artists, round(sum(minutes) / 60)::INT AS hours FROM p`);
    const quality = await dataQuality();
    const skip = await m.trainSkipModel({ seed: 1, permutations: 8 });
    const sens = await m.sensitivity();
    const eras = await m.detectEras(7);
    const surv = await m.artistSurvival(90);
    const sessions = await m.sessionStats();
    const [moodAgree] = await engine.query<{ r: number; n: number }>(
      `SELECT corr(valence_audio, valence_lyrics) AS r, count(*)::INT AS n FROM meta WHERE valence_audio IS NOT NULL AND valence_lyrics IS NOT NULL`,
    );

    let bench: unknown = null;
    if (process.env.ANALYSIS_BENCH === '1') {
      const { runMoodBench } = await import('../src/llm/moodBench');
      const { getApp } = await import('../src/lib/store');
      const s = getApp().settings;
      if (s.openrouterKey) bench = await runMoodBench({ n: Number(process.env.ANALYSIS_BENCH_N ?? 300), seed: 1 });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      seeds: { skip: 1, bench: 1 },
      dataset: ds,
      quality,
      skip: skip && {
        auc: r3(skip.auc),
        aucCI: skip.aucCI.map(r3),
        momentum: r3(skip.baselines.momentum),
        momentumCI: skip.baselines.momentumCI.map(r3),
        preference: r3(skip.baselines.preference),
        preferenceCI: skip.baselines.preferenceCI.map(r3),
        baseRate: r3(skip.baseRate),
        nTrain: skip.nTrain,
        nTest: skip.nTest,
        effects: skip.effects.map((e) => ({ name: e.name, group: e.group, dAuc: r3(e.importance), sd: r3(e.importanceSd), coef: r3(e.coef) })),
      },
      eras: eras.map((e) => ({ from: e.from, to: e.to, top: e.topArtists })),
      survival: { medianDays: surv.medianDays, n: surv.n, leftTruncated: surv.leftTruncated },
      sensitivity: sens,
      sessions: { n: sessions.sessions, kinds: sessions.kinds.map((k) => ({ kind: k.kind, n: k.n })) },
      mood: { audioVsLyricsValence: { r: r3(moodAgree?.r), n: moodAgree?.n ?? 0 }, bench },
    };

    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${OUT}/report.md`, toMarkdown(report));
    console.log(`report → ${OUT}/report.json, ${OUT}/report.md`);
    expect(report.skip).not.toBeNull();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMarkdown(r: any): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ci = (a: number[]) => `[${a[0]}, ${a[1]}]`;
  const L: string[] = [];
  L.push(`# Ascolti — report di analisi`, '', `Generato: ${r.generatedAt} · seed fissi: ${JSON.stringify(r.seeds)}`, '');
  const d = r.dataset;
  L.push(`## Dati`, '', `${d.plays} riproduzioni (${d.counted} ≥ 30 s), ${d.first_day} → ${d.last_day}, ${d.tracks} brani, ${d.artists} artisti, ${d.hours} ore.`);
  const q = r.quality;
  L.push('', `Pulizia: ${q.rawRows} righe grezze, ${q.duplicatesRemoved} duplicati rimossi, ${q.excludedRows} esclusi, ${q.short} sotto i 30 s.`, '');
  L.push('| anno | riproduzioni | salti | chiusi con avanti | telefono | shuffle |', '|---|---|---|---|---|---|');
  for (const y of q.byYear) L.push(`| ${y.year} | ${y.plays} | ${pct(y.skipRate)} | ${pct(y.fwdShare)} | ${pct(y.mobileShare)} | ${pct(y.shuffleShare)} |`);
  if (r.skip) {
    const s = r.skip;
    L.push('', `## Predizione degli skip`, '', `Split temporale ${s.nTrain}/${s.nTest}, tasso base ${pct(s.baseRate)}.`, '');
    L.push('| modello | AUC | IC 95% |', '|---|---|---|');
    L.push(`| solo slancio | ${s.momentum} | ${ci(s.momentumCI)} |`, `| solo brano | ${s.preference} | ${ci(s.preferenceCI)} |`, `| completo | ${s.auc} | ${ci(s.aucCI)} |`);
    L.push('', '| caratteristica | gruppo | ΔAUC | sd | coeff. |', '|---|---|---|---|---|');
    for (const e of s.effects) L.push(`| ${e.name} | ${e.group} | ${e.dAuc} | ${e.sd} | ${e.coef} |`);
  }
  L.push('', `## Ciclo di vita degli artisti`, '', `Mediana ${r.survival.medianDays ?? '—'} giorni su ${r.survival.n} artisti (${r.survival.leftTruncated} esclusi perché già noti all'inizio dei dati).`, '');
  L.push('| soglia | mediana | artisti |', '|---|---|---|');
  for (const x of r.sensitivity.survival) L.push(`| ${x.churnGapDays} g | ${x.medianDays ?? '—'} | ${x.n} |`);
  L.push('', `## Ere`, '', ...r.eras.map((e: { from: string; to: string; top: string[] }) => `- ${e.from} → ${e.to}: ${e.top.join(', ')}`));
  L.push('', `Stabilità dei confini al variare della penalità: ${pct(r.sensitivity.eraStability)} · ${r.sensitivity.eras.map((e: { penalty: number; eras: number }) => `${e.penalty}→${e.eras}`).join(', ')}`);
  L.push('', `## Mood`, '', `Accordo valence audio/testo: r = ${r.mood.audioVsLyricsValence.r} (n = ${r.mood.audioVsLyricsValence.n}).`);
  const b = r.mood.bench;
  if (b) {
    L.push('', `Benchmark: ${b.nTest} brani di prova (artisti disgiunti), baseline costante MAE valence ${b.baseline.maeValence.toFixed(3)}, energia ${b.baseline.maeEnergy.toFixed(3)}.`, '');
    L.push('| stimatore | dim. | MAE [IC] | r [IC] | skill | valida |', '|---|---|---|---|---|---|');
    for (const p of b.providers)
      for (const k of ['valence', 'energy'])
        L.push(`| ${p.model} | ${k} | ${p[k].mae.toFixed(3)} [${p[k].maeCI.map((x: number) => x.toFixed(3)).join(', ')}] | ${p[k].r.toFixed(2)} [${p[k].rCI.map((x: number) => x.toFixed(2)).join(', ')}] | ${pct(p[k].skill)} | ${p.useful[k] ? 'sì' : 'no'} |`);
  }
  return L.join('\n') + '\n';
}

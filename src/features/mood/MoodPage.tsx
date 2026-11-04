import { useCallback, useMemo, useRef, useState } from 'react';
import { Orbit, Search, Sparkles, Wand2, RefreshCw, X } from 'lucide-react';
import { useSql, useSqlOne, useAsync } from '../../data/useSql';
import { useApp } from '../../lib/store';
import { fmtHours, fmtInt, fmtPct, fmtMonth } from '../../lib/format';
import { getMood, MOODS, MOOD_HEX, MOOD_SQL, moodLabel } from '../../lib/mood';
import { navigate, routes } from '../../lib/router';
import { idb } from '../../lib/idb';
import { buildIndex, computeLayout, DEFAULT_EMBED_MODEL, EMBED_MODELS, loadIndex, semanticSearch } from '../../ml/embeddings';
import { runStep } from '../../enrichment/jobs';
import { runMoodV2, moodCandidates, type MoodRunReport } from '../../llm/mood';
import { nameClustersWithLLM } from '../../llm/narrate';
import { useLlmAvailable, estimateTokens } from '../../llm/client';
import { Badge, Button, Card, ErrorNote, Meter, PageHeader, Section, Segmented, Skeleton, Spinner } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { Galaxy, type GalaxyPoint } from '../../components/charts/Galaxy';
import { MoodPlane } from '../../components/charts/common';
import { PlotChart, Plot } from '../../components/charts/PlotChart';
import { MoodTimeline } from './MoodTimeline';

const CLUSTER_COLORS = ['#e8b94a', '#5cc6c0', '#e0604f', '#7f7bd6', '#8fd16a', '#e98ac0', '#4fa3e0', '#d9a066', '#b5e3d8', '#c7a3ff', '#f2d16b', '#6fd6a8', '#ff9f7a', '#9ab0ff'];

interface MapRow {
  uri: string;
  track: string;
  artist: string;
  x: number;
  y: number;
  cluster: number;
  minutes: number;
  valence: number | null;
  energy: number | null;
}

function MoodStatus() {
  const ai = useLlmAvailable();
  const cov = useSqlOne<{ with_mood: number; total: number; reccobeats: number; llm: number }>(`
    SELECT sum(minutes) FILTER (WHERE p.valence IS NOT NULL) AS with_mood, sum(minutes) AS total,
           count(DISTINCT p.uri) FILTER (WHERE m.mood_source = 'reccobeats') AS reccobeats,
           count(DISTINCT p.uri) FILTER (WHERE m.mood_source = 'llm') AS llm
    FROM p LEFT JOIN meta m USING (uri)`);
  const report = useAsync(() => idb.get<MoodRunReport>('mood_report'));
  const job = useApp((s) => s.jobs.audiofeatures);
  const setJob = useApp((s) => s.setJob);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState(400);
  const ctrl = useRef<AbortController | null>(null);
  const candidates = useAsync(() => moodCandidates(5000));
  const c = cov.row;
  const pct = c && c.total ? c.with_mood / c.total : 0;
  const nCand = candidates.value?.length ?? 0;
  const estTok = estimateTokens(Math.min(limit, nCand) * 520 + Math.ceil(Math.min(limit, nCand) / 12) * 6000) * 2;

  const runLlm = async () => {
    setErr(null);
    setRunning(true);
    ctrl.current = new AbortController();
    try {
      await runMoodV2({
        limit,
        samples: 2,
        signal: ctrl.current.signal,
        onProgress: (done, total) => setJob({ id: 'mood_llm', label: 'Mood AI (testi + tag)', done, total, status: 'running' }),
      });
      setJob({ id: 'mood_llm', label: 'Mood AI (testi + tag)', done: 1, total: 1, status: 'done' });
    } catch (e) {
      if (!ctrl.current.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs text-text-faint">Copertura mood (sul tempo di ascolto)</div>
          <div className="num text-3xl">{fmtPct(pct)}</div>
          <div className="text-xs text-text-muted">
            {fmtInt(c?.reccobeats ?? 0)} brani misurati · {fmtInt(c?.llm ?? 0)} stimati con AI
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void runStep('audiofeatures')} disabled={job?.status === 'running'}>
            {job?.status === 'running' ? <Spinner size={14} /> : <RefreshCw size={14} />} Audio features
          </Button>
        </div>
      </div>
      <div className="w-full">
        <Meter value={pct} max={1} />
      </div>
      <div className="rounded-xl border border-border bg-surface-2/50 p-3 text-sm">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Sparkles size={15} className="text-[var(--accent)]" /> Stima AI per i brani senza audio features
        </div>
        <p className="text-text-muted">
          Usa testo e generi del brano, calibrata su {fmtInt(c?.reccobeats ?? 0)} brani con valori misurati (esempi nel prompt). Ogni brano viene
          stimato 2 volte: la differenza diventa la confidenza. {fmtInt(nCand)} brani hanno testo o tag disponibili.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Brani
            <input
              type="number"
              min={20}
              max={5000}
              step={20}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="h-8 w-24 rounded-lg border border-border bg-surface-1 px-2 text-sm text-text"
            />
          </label>
          <span className="num text-xs text-text-faint">≈ {fmtInt(estTok)} token</span>
          {running ? (
            <Button size="sm" variant="danger" onClick={() => ctrl.current?.abort()}>
              <X size={14} /> Ferma
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!ai || !nCand} onClick={() => void runLlm()}>
              <Wand2 size={14} /> Stima mood
            </Button>
          )}
          {!ai && (
            <a href={routes.settings()} className="text-xs text-[var(--accent)]">
              Serve una chiave OpenRouter
            </a>
          )}
        </div>
        {err && <div className="mt-2"><ErrorNote>{err}</ErrorNote></div>}
        {report.value?.calibration && (
          <div className="mt-3 text-xs text-text-muted">
            Ultima verifica su {report.value.calibration.n} brani misurati nascosti al modello: errore medio valence{' '}
            <span className="num">{report.value.calibration.maeValence.toFixed(2)}</span> (r = <span className="num">{report.value.calibration.rValence.toFixed(2)}</span>), energia{' '}
            <span className="num">{report.value.calibration.maeEnergy.toFixed(2)}</span> (r = <span className="num">{report.value.calibration.rEnergy.toFixed(2)}</span>).
          </div>
        )}
      </div>
    </Card>
  );
}

function GalaxySection() {
  const ai = useLlmAvailable();
  const epoch = useApp((s) => s.epoch);
  const index = useAsync(loadIndex, [epoch]);
  const rows = useSql<MapRow>(`
    SELECT t.uri, t.track, t.artist, m.x, m.y, m.cluster, t.minutes, m.valence, m.energy
    FROM tracks t JOIN meta m USING (uri) WHERE m.x IS NOT NULL`);
  const clusters = useSql<{ id: number; label: string }>(`SELECT id, label FROM clusters ORDER BY id`);
  const periodUris = useSql<{ uri: string }>(`SELECT DISTINCT uri FROM p`);
  const [colorBy, setColorBy] = useState<'cluster' | 'mood'>('cluster');
  const [n, setN] = useState(2500);
  const [building, setBuilding] = useState<{ stage: string; done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ uri: string; score: number }> | null>(null);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [focusCluster, setFocusCluster] = useState<number | null>(null);
  const [naming, setNaming] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const inPeriod = useMemo(() => new Set((periodUris.data ?? []).map((r) => r.uri)), [periodUris.data]);
  const hitSet = useMemo(() => (hits ? new Set(hits.slice(0, 40).map((h) => h.uri)) : null), [hits]);
  const selSet = useMemo(() => (selection ? new Set(selection) : null), [selection]);

  const points: GalaxyPoint[] = useMemo(
    () =>
      (rows.data ?? []).map((r) => ({
        id: r.uri,
        x: r.x,
        y: r.y,
        r: 1.5 + Math.sqrt(r.minutes) * 0.35,
        color: colorBy === 'cluster' ? CLUSTER_COLORS[r.cluster % CLUSTER_COLORS.length] : MOOD_HEX[getMood(r.valence, r.energy)],
        label: r.track,
        sub: r.artist,
        dim:
          (hitSet ? !hitSet.has(r.uri) : false) ||
          (focusCluster != null && r.cluster !== focusCluster) ||
          (inPeriod.size > 0 && !inPeriod.has(r.uri)),
      })),
    [rows.data, colorBy, hitSet, focusCluster, inPeriod],
  );

  const labels = useMemo(() => {
    if (!rows.data?.length || !clusters.data) return [];
    const acc = new Map<number, { x: number; y: number; w: number }>();
    for (const r of rows.data) {
      const a = acc.get(r.cluster) ?? { x: 0, y: 0, w: 0 };
      const w = Math.sqrt(r.minutes) + 0.1;
      a.x += r.x * w;
      a.y += r.y * w;
      a.w += w;
      acc.set(r.cluster, a);
    }
    const lm = new Map(clusters.data.map((c) => [c.id, c.label]));
    return Array.from(acc.entries()).map(([id, a]) => ({ x: a.x / a.w, y: a.y / a.w, text: lm.get(id) ?? `Gruppo ${id + 1}` }));
  }, [rows.data, clusters.data]);

  const clusterStats = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of rows.data ?? []) m.set(r.cluster, (m.get(r.cluster) ?? 0) + r.minutes);
    return (clusters.data ?? []).map((c) => ({ ...c, minutes: m.get(c.id) ?? 0 })).sort((a, b) => b.minutes - a.minutes);
  }, [rows.data, clusters.data]);

  const build = async () => {
    setErr(null);
    ctrl.current = new AbortController();
    try {
      setBuilding({ stage: 'Avvio', done: 0, total: 1 });
      await buildIndex(DEFAULT_EMBED_MODEL, n, (stage, done, total) => setBuilding({ stage, done, total }), ctrl.current.signal);
    } catch (e) {
      if (!ctrl.current.signal.aborted) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(null);
    }
  };

  const relayout = async () => {
    const idx = await loadIndex();
    if (!idx) return;
    setBuilding({ stage: 'Ricalcolo mappa', done: 0, total: 1 });
    try {
      await computeLayout(idx, (stage, done, total) => setBuilding({ stage, done, total }));
    } finally {
      setBuilding(null);
    }
  };

  const search = async () => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    setErr(null);
    try {
      setHits(await semanticSearch(q.trim(), 40));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const hitRows = useMemo(() => {
    if (!hits || !rows.data) return [];
    const m = new Map(rows.data.map((r) => [r.uri, r]));
    const seen = new Set<string>();
    return hits
      .map((h) => ({ ...m.get(h.uri), score: h.score }))
      .filter((x) => {
        if (!x.track) return false;
        const k = `${x.track.toLowerCase().replace(/\s*[([].*$/, '')}|${x.artist?.toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 12) as Array<MapRow & { score: number }>;
  }, [hits, rows.data]);

  const selRows = useMemo(() => (selSet && rows.data ? rows.data.filter((r) => selSet.has(r.uri)).sort((a, b) => b.minutes - a.minutes) : []), [selSet, rows.data]);

  if (index.loading && !index.value) return <Skeleton className="h-40" />;
  if (!index.value && !building) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <div className="flex items-center gap-2 text-lg font-medium">
          <Orbit size={20} className="text-[var(--accent)]" /> Crea la mappa del tuo gusto
        </div>
        <p className="max-w-2xl text-sm text-text-muted">
          Ogni brano (titolo, artista, album, generi e testo) diventa un vettore con {EMBED_MODELS[DEFAULT_EMBED_MODEL].id} tramite OpenRouter, con la
          tua chiave. Poi una proiezione UMAP, calcolata nel browser, li dispone su una mappa: brani vicini = brani simili. Costo indicativo:
          circa $0,05 ogni 1.000 brani. Più testi e tag hai arricchito, migliore sarà la mappa.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text-muted">
            Brani
            <input type="number" min={100} max={20000} step={100} value={n} onChange={(e) => setN(Number(e.target.value))} className="h-9 w-24 rounded-full border border-border bg-surface-2 px-3 text-sm text-text" />
          </label>
          <Button variant="primary" onClick={() => void build()} disabled={!ai}>
            <Orbit size={16} /> Crea mappa
          </Button>
          {!ai && (
            <a href={routes.settings()} className="text-xs text-[var(--accent)]">
              Serve la chiave OpenRouter
            </a>
          )}
        </div>
        {err && <ErrorNote>{err}</ErrorNote>}
      </Card>
    );
  }

  if (!index.value && building) {
    return (
      <Card className="flex items-center gap-4">
        <Spinner />
        <div className="min-w-0 flex-1">
          <div className="text-sm">{building.stage}</div>
          {building.total > 1 && <Meter value={building.done} max={building.total} />}
          <div className="mt-1 text-xs text-text-faint">Gli embedding arrivano da OpenRouter a blocchi da 96 brani.</div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => ctrl.current?.abort()}>
          Annulla
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {building && (
        <Card className="flex items-center gap-4">
          <Spinner />
          <div className="min-w-0 flex-1">
            <div className="text-sm">{building.stage}</div>
            {building.total > 1 && <Meter value={building.done} max={building.total} />}
          </div>
          <Button size="sm" variant="ghost" onClick={() => ctrl.current?.abort()}>
            Annulla
          </Button>
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cerca per atmosfera: “malinconia d’inverno”, “rap che carica”, “canzoni sul mare”…"
            aria-label="Ricerca semantica"
            className="h-10 w-full rounded-full border border-border bg-surface-1 pl-9 pr-24 text-sm"
          />
          <div className="absolute right-1 top-1 flex gap-1">
            {hits && (
              <button type="button" onClick={() => { setHits(null); setQ(''); }} className="grid size-8 place-items-center rounded-full text-text-faint hover:bg-surface-2" aria-label="Pulisci">
                <X size={14} />
              </button>
            )}
            <Button size="sm" variant="primary" type="submit">
              Cerca
            </Button>
          </div>
        </form>
        <Segmented
          value={colorBy}
          onChange={setColorBy}
          options={[
            { value: 'cluster', label: 'Per gruppo' },
            { value: 'mood', label: 'Per mood' },
          ]}
        />
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      <Card className="overflow-hidden p-0">
        {rows.data ? (
          <Galaxy
            points={points}
            labels={colorBy === 'cluster' && !hits ? labels : undefined}
            height={560}
            onPick={(id) => navigate(routes.track(id))}
            onLasso={(ids) => setSelection(ids)}
          />
        ) : (
          <Skeleton className="h-[560px]" />
        )}
      </Card>

      {hits && (
        <div>
          <div className="mb-2 text-sm text-text-muted">I brani più vicini a “{q}”</div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {hitRows.map((h) => (
              <a key={h.uri} href={routes.track(h.uri)} className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
                <div className="num w-10 text-right text-xs text-text-faint">{Math.round(h.score * 100)}</div>
                <div className="min-w-0">
                  <div className="truncate text-sm">{h.track}</div>
                  <div className="truncate text-xs text-text-faint">{h.artist}</div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {selRows.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="font-medium">{fmtInt(selRows.length)} brani selezionati</div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  navigate(
                    routes.ask(
                      `Cosa hanno in comune questi brani e quando li ascoltavo? uri: ${selRows
                        .slice(0, 25)
                        .map((r) => r.uri)
                        .join(', ')}`,
                    ),
                  )
                }
              >
                <Sparkles size={14} /> Chiedi su questa selezione
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
                <X size={14} />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {selRows.slice(0, 18).map((r) => (
              <a key={r.uri} href={routes.track(r.uri)} className="truncate rounded-lg px-2 py-1 text-sm hover:bg-surface-2">
                {r.track} <span className="text-text-faint">— {r.artist}</span>
              </a>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {clusterStats.map((c) => (
          <button
            key={c.id}
            onClick={() => setFocusCluster((f) => (f === c.id ? null : c.id))}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${focusCluster === c.id ? 'border-text bg-surface-3' : 'border-border bg-surface-1 hover:bg-surface-2'}`}
          >
            <span className="size-2.5 rounded-full" style={{ background: CLUSTER_COLORS[c.id % CLUSTER_COLORS.length] }} />
            {c.label} <span className="num text-text-faint">{fmtHours(c.minutes)}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!ai || naming}
          onClick={async () => {
            setNaming(true);
            setErr(null);
            try {
              await nameClustersWithLLM();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setNaming(false);
            }
          }}
        >
          {naming ? <Spinner size={14} /> : <Wand2 size={14} />} Dai un nome ai gruppi con AI
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void relayout()} disabled={!!building}>
          <RefreshCw size={14} /> Ricalcola mappa
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void build()} disabled={!!building}>
          Ricrea indice ({fmtInt(index.value?.uris.length ?? 0)} brani)
        </Button>
      </div>
    </div>
  );
}

export default function MoodPage() {
  const dist = useSql<{ mood: string; minutes: number }>(`
    SELECT ${MOOD_SQL()} mood, sum(minutes) AS minutes FROM p GROUP BY 1`);
  const plane = useSql<{ uri: string; track: string; artist: string; valence: number; energy: number; minutes: number }>(`
    SELECT uri, any_value(track) AS track, any_value(artist) AS artist, any_value(valence) AS valence, any_value(energy) AS energy, sum(minutes) AS minutes
    FROM p WHERE valence IS NOT NULL AND energy IS NOT NULL GROUP BY uri ORDER BY minutes DESC LIMIT 400`);
  const trend = useSql<{ ym: string; valence: number; energy: number; n: number }>(`
    SELECT strftime(day, '%Y-%m') AS ym, sum(valence * minutes) / sum(minutes) AS valence, sum(energy * minutes) / sum(minutes) AS energy, count(*) AS n
    FROM p WHERE valence IS NOT NULL GROUP BY 1 HAVING count(*) >= 20 ORDER BY 1`);
  const extremes = useSql<{ ym: string; valence: number; z: number }>(`
    WITH m AS (SELECT strftime(day, '%Y-%m') AS ym, sum(valence * minutes) / sum(minutes) AS valence FROM p WHERE valence IS NOT NULL GROUP BY 1 HAVING count(*) >= 20)
    SELECT ym, valence, (valence - avg(valence) OVER ()) / nullif(stddev(valence) OVER (), 0) AS z FROM m ORDER BY abs(z) DESC LIMIT 2`);

  const known = (dist.data ?? []).filter((d) => d.mood !== 'sconosciuto');
  const totKnown = known.reduce((a, b) => a + b.minutes, 0);
  const top = known.reduce<{ mood: string; minutes: number } | null>((a, b) => (!a || b.minutes > a.minutes ? b : a), null);

  const planePts = useMemo(
    () =>
      (plane.data ?? []).map((d) => ({
        valence: d.valence,
        energy: d.energy,
        label: `${d.track} — ${d.artist}`,
        color: MOOD_HEX[getMood(d.valence, d.energy)],
        r: 2 + Math.sqrt(d.minutes) / 3,
      })),
    [plane.data],
  );

  const trendChart = useCallback(
    (width: number) => {
      const rows = (trend.data ?? []).flatMap((d) => [
        { date: new Date(d.ym + '-01'), v: d.valence, s: 'Positività' },
        { date: new Date(d.ym + '-01'), v: d.energy, s: 'Energia' },
      ]);
      return {
        height: 230,
        x: { type: 'utc' as const, label: null, ticks: width < 600 ? 4 : 8 },
        y: { domain: [0.2, 0.85], grid: true, label: null },
        color: { domain: ['Positività', 'Energia'], range: [MOOD_HEX.euforico, MOOD_HEX.malinconico], legend: true },
        marks: [
          Plot.ruleY([0.5], { stroke: 'var(--color-border-strong)', strokeDasharray: '3,3' }),
          Plot.lineY(rows, { x: 'date', y: 'v', stroke: 's', strokeWidth: 2, curve: 'monotone-x' }),
          Plot.tip(rows, Plot.pointerX({ x: 'date', y: 'v', stroke: 's', title: (d: { date: Date; v: number; s: string }) => `${fmtMonth(d.date.toISOString().slice(0, 7))}\n${d.s}: ${d.v.toFixed(2)}` })),
        ],
      };
    },
    [trend.data],
  );

  return (
    <div className="flex flex-col gap-12">
      <PageHeader
        kicker="Mood & Galassia"
        title={top ? <>Il tuo suono è soprattutto <em style={{ color: MOOD_HEX[top.mood as keyof typeof MOOD_HEX] }}>{moodLabel(top.mood as never).toLowerCase()}</em></> : 'Che suono ha il tuo gusto'}
        sub="Positività (valence) ed energia di ogni brano, misurate dall’audio quando possibile o stimate dall’AI su testo e generi, con confidenza dichiarata."
      />

      <Section kicker="Umore nel tempo" title="Quando eri più felice e quando più triste, secondo ciò che ascoltavi">
        <MoodTimeline />
      </Section>

      <MoodStatus />

      {totKnown > 0 && (
        <Section kicker="Distribuzione" title="Il tempo che passi in ogni stato d’animo">
          <div className="flex h-14 overflow-hidden rounded-2xl">
            {MOODS.map((m) => {
              const d = known.find((k) => k.mood === m.id);
              if (!d) return null;
              return (
                <div key={m.id} className="flex min-w-0 flex-col justify-center px-3" style={{ flex: `${d.minutes} 1 0`, background: MOOD_HEX[m.id] + '33', borderTop: `3px solid ${MOOD_HEX[m.id]}` }} title={`${m.label}: ${fmtHours(d.minutes)}`}>
                  <div className="truncate text-sm font-medium">{m.label}</div>
                  <div className="num truncate text-xs text-text-muted">{fmtPct(d.minutes / totKnown)}</div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {planePts.length > 10 && (
        <div className="grid gap-10 lg:grid-cols-2">
          <Section kicker="Piano emotivo" title="I tuoi 400 brani più ascoltati">
            <Card className="p-4">
              <MoodPlane points={planePts} />
            </Card>
          </Section>
          <Section
            kicker="Nel tempo"
            title={
              extremes.data?.[0] ? (
                <>
                  {extremes.data[0].z < 0 ? 'Il mese più cupo' : 'Il mese più solare'}: {fmtMonth(extremes.data[0].ym)}
                </>
              ) : (
                'Mood mese per mese'
              )
            }
          >
            <Card className="p-4">{trend.data ? <PlotChart make={trendChart} height={230} ariaLabel="Positività ed energia medie per mese" /> : <Skeleton className="h-52" />}</Card>
          </Section>
        </div>
      )}

      <Section kicker="Galassia" title="La mappa del tuo gusto" action={<Badge tone="accent">embedding via OpenRouter</Badge>}>
        <GalaxySection />
      </Section>

      <TopMoodTracks />
    </div>
  );
}

function TopMoodTracks() {
  const [mood, setMood] = useState<(typeof MOODS)[number]['id']>('malinconico');
  const rows = useSql<{ uri: string; track: string; artist: string; cover: string | null; minutes: number }>(
    `SELECT uri, any_value(track) AS track, any_value(artist) AS artist, any_value(cover) AS cover, sum(minutes) AS minutes
     FROM p WHERE ${MOOD_SQL()} = ? GROUP BY uri ORDER BY minutes DESC LIMIT 20`,
    [mood],
  );
  return (
    <Section
      kicker="Per stato d’animo"
      title="I brani che usi per ogni umore"
      action={<Segmented value={mood} onChange={setMood} options={MOODS.filter((m) => m.id !== 'neutrale').map((m) => ({ value: m.id, label: m.label }))} />}
    >
      {rows.data?.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6 2xl:grid-cols-8 min-[2400px]:grid-cols-10">
          {rows.data.map((r, i) => (
            <a key={r.uri} href={routes.track(r.uri)} className={`group min-w-0 ${i >= 16 ? 'hidden min-[2400px]:block' : i >= 12 ? 'hidden 2xl:block' : ''}`}>
              <Cover src={r.cover} name={r.track} size="fill" className="rounded-xl" />
              <div className="mt-2 truncate text-sm group-hover:text-[var(--accent)]">{r.track}</div>
              <div className="truncate text-xs text-text-faint">{r.artist}</div>
            </a>
          ))}
        </div>
      ) : (
        <p className="text-sm text-text-faint">Nessun brano con questo mood nel periodo (o mood non ancora calcolato).</p>
      )}
    </Section>
  );
}

import { useCallback, useState } from 'react';
import { ThumbsDown, ThumbsUp, Wand2, RefreshCw, Info } from 'lucide-react';
import { useAsync } from '../../data/useSql';
import { artistSurvival, detectEras, rediscoveryCandidates, rediscoveryFeedback, trainSkipModel, type Candidate, type Era } from '../../ml/models';
import { nameErasWithLLM } from '../../llm/narrate';
import { useLlmAvailable } from '../../llm/client';
import { fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { routes } from '../../lib/router';
import { spotifyId } from '../../enrichment/providers';
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Section, Skeleton, Spinner } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { PlotChart, Plot } from '../../components/charts/PlotChart';

function Explain({ children }: { children: React.ReactNode }) {
  return (
    <details className="group mt-3 text-xs text-text-faint">
      <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-text-muted">
        <Info size={12} /> Come funziona
      </summary>
      <div className="mt-2 max-w-3xl leading-relaxed">{children}</div>
    </details>
  );
}

function SkipModel() {
  const [seed, setSeed] = useState(0);
  const res = useAsync(trainSkipModel, [seed]);
  const m = res.value;
  const hourChart = useCallback(
    () => ({
      height: 180,
      marginLeft: 40,
      x: { label: 'ora', tickFormat: (h: number) => (h % 3 === 0 ? String(h) : '') },
      y: { label: 'salti', grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}%` },
      marks: [Plot.barY(m?.byHour ?? [], { x: 'hour', y: 'rate', fill: 'var(--accent)', rx: 2 }), Plot.ruleY([m?.baseRate ?? 0], { stroke: 'var(--color-text-faint)', strokeDasharray: '3,3' })],
    }),
    [m],
  );
  const posChart = useCallback(
    () => ({
      height: 180,
      marginLeft: 40,
      x: { label: 'posizione nella sessione →', tickFormat: (p: number) => (p === 30 ? '30+' : p % 5 === 0 ? String(p) : '') },
      y: { label: 'salti', grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}%` },
      marks: [Plot.lineY(m?.byPos ?? [], { x: 'pos', y: 'rate', stroke: 'var(--accent)', strokeWidth: 2, curve: 'monotone-x' })],
    }),
    [m],
  );
  if (res.loading) return <Skeleton className="h-64" />;
  if (res.error) return <ErrorNote>{res.error}</ErrorNote>;
  if (!m) return <Empty title="Servono almeno 500 ascolti nel periodo" />;
  const strong = m.effects.filter((e) => e.importance > 0.003).slice(0, 5);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Card>
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={m.auc > 0.7 ? 'good' : 'neutral'}>AUC {m.auc.toFixed(2)}</Badge>
            <span className="text-xs text-text-faint">
              addestrato su {fmtInt(m.nTrain)} ascolti, verificato sugli ultimi {fmtInt(m.nTest)}
            </span>
          </div>
          <h3 className="mt-3 text-lg font-medium">Cosa ti fa saltare un brano</h3>
          <ol className="mt-3 flex flex-col gap-3">
            {strong.map((e, i) => (
              <li key={e.name} className="flex items-start gap-3">
                <span className="num mt-0.5 text-sm text-text-faint">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-text">{e.sentence.charAt(0).toUpperCase() + e.sentence.slice(1)}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-faint">
                    {e.name}
                    <div className="h-1 w-24 rounded-full bg-surface-3">
                      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, (e.importance / Math.max(1e-6, strong[0].importance)) * 100)}%` }} />
                    </div>
                  </div>
                </div>
              </li>
            ))}
            {!strong.length && <li className="text-sm text-text-muted">Nessun fattore spicca: i tuoi salti sono abbastanza casuali.</li>}
          </ol>
          <Explain>
            Regressione logistica addestrata nel browser su {14} caratteristiche di ogni ascolto (ora, shuffle, posizione nella sessione, quante volte
            l’avevi già sentito, somiglianza con il brano precedente via embedding, mood…). La validazione è temporale: il modello impara dal passato e
            viene giudicato sugli ascolti più recenti. L’importanza è misurata permutando ogni caratteristica e guardando quanto peggiora l’AUC
            (0,5 = caso, 1 = perfetto).
          </Explain>
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <div className="mb-2 text-sm text-text-muted">Salti per ora del giorno (linea = media)</div>
            <PlotChart make={hourChart} height={180} ariaLabel="Tasso di salto per ora" />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-sm text-text-muted">Salti man mano che la sessione va avanti</div>
            <PlotChart make={posChart} height={180} ariaLabel="Tasso di salto per posizione nella sessione" />
          </Card>
        </div>
      </div>
      <div>
        <Button size="sm" variant="ghost" onClick={() => setSeed((s) => s + 1)}>
          <RefreshCw size={14} /> Riaddestra
        </Button>
      </div>
    </div>
  );
}

function Eras() {
  const ai = useLlmAvailable();
  const [v, setV] = useState(0);
  const eras = useAsync(() => detectEras(7), [v]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (eras.loading) return <Skeleton className="h-48" />;
  const list = eras.value ?? [];
  if (list.length < 2) return <Empty title="Periodo troppo breve per individuare delle ere">Seleziona “Tutto” in alto.</Empty>;
  return (
    <div className="flex flex-col gap-4">
      <ol className="relative flex flex-col gap-4 border-l border-border pl-6">
        {list.map((e: Era) => (
          <li key={e.from} className="relative">
            <span className="absolute -left-[31px] top-1.5 size-3 rounded-full border-2 border-bg bg-[var(--accent)]" />
            <div className="text-xs text-text-faint">
              {fmtMonth(e.from)} → {fmtMonth(e.to)} · {e.months} mesi · {fmtHours(e.minutes)}
            </div>
            <div className="display text-3xl">{e.name}</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {e.topArtists.map((a) => (
                <a key={a} href={routes.artist(a)} className="rounded-full border border-border bg-surface-1 px-2.5 py-1 text-xs hover:bg-surface-2">
                  {a}
                </a>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!ai || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await nameErasWithLLM(list);
              setV((x) => x + 1);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size={14} /> : <Wand2 size={14} />} Dai un titolo alle ere con AI
        </Button>
        {err && <ErrorNote>{err}</ErrorNote>}
      </div>
      <Explain>
        Per ogni mese costruiamo un “vettore del gusto” (quota di ascolto dei tuoi 60 artisti principali, distanza di Hellinger). Una segmentazione
        binaria cerca i punti in cui il gusto cambia di più e si ferma quando un ulteriore taglio non spiega abbastanza varianza.
      </Explain>
    </div>
  );
}

function Lifecycle() {
  const s = useAsync(() => artistSurvival(90));
  const make = useCallback(
    () => ({
      height: 220,
      marginLeft: 44,
      x: { label: 'giorni dalla scoperta →' },
      y: { label: 'artisti ancora ascoltati', domain: [0, 1], grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}%` },
      marks: [Plot.lineY(s.value?.curve ?? [], { x: 'days', y: 'survival', curve: 'step-after', stroke: 'var(--accent)', strokeWidth: 2 }), Plot.ruleY([0.5], { stroke: 'var(--color-text-faint)', strokeDasharray: '3,3' })],
    }),
    [s.value],
  );
  if (s.loading) return <Skeleton className="h-60" />;
  const v = s.value;
  if (!v || v.curve.length < 3) return <Empty title="Dati insufficienti" />;
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Card className="p-4">
        <div className="mb-2 text-lg font-medium">
          {v.medianDays ? <>Metà degli artisti che scopri li lasci entro {fmtInt(v.medianDays)} giorni</> : 'La maggior parte degli artisti resta con te'}
        </div>
        <PlotChart make={make} height={220} ariaLabel="Curva di sopravvivenza degli artisti" />
        <Explain>
          Stimatore di Kaplan–Meier: un artista “esce” quando passano più di {v.churnGapDays} giorni senza ascoltarlo. Gli artisti ancora attivi
          sono trattati come osservazioni censurate, quindi la curva non penalizza le scoperte recenti.
        </Explain>
      </Card>
      <div className="flex flex-col gap-6">
        <div>
          <div className="mb-2 text-sm font-medium">Fedelissimi (tornano sempre)</div>
          <div className="flex flex-wrap gap-2">
            {v.loyal.map((l) => (
              <a key={l.artist} href={routes.artist(l.artist)} className="rounded-full border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2">
                {l.artist} <span className="num text-xs text-text-faint">{l.returns}× ritorni</span>
              </a>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Fiammate (un mese e via)</div>
          <div className="flex flex-col gap-1">
            {v.flames.map((f) => (
              <a key={f.artist} href={routes.artist(f.artist)} className="flex justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                <span className="truncate">{f.artist}</span>
                <span className="num shrink-0 text-xs text-text-faint">
                  picco {fmtMonth(f.peakMonth)} · ultimo {fmtDate(f.lastDay)}
                </span>
              </a>
            ))}
            {!v.flames.length && <div className="text-sm text-text-faint">Nessuna fiammata: sei costante.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Rediscovery() {
  const [v, setV] = useState(0);
  const c = useAsync(() => rediscoveryCandidates(12), [v]);
  const [voted, setVoted] = useState<Record<string, boolean>>({});
  const vote = async (x: Candidate, liked: boolean) => {
    await rediscoveryFeedback(x, liked);
    setVoted((s) => ({ ...s, [x.uri]: liked }));
  };
  if (c.loading) return <Skeleton className="h-60" />;
  if (!c.value?.length) return <Empty title="Nessun brano da riscoprire">Servono brani ascoltati più volte e fermi da almeno 6 mesi.</Empty>;
  const ids = c.value.map((x) => spotifyId(x.uri)).filter(Boolean);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {c.value.map((x) => (
          <div key={x.uri} className="flex items-center gap-3 rounded-2xl border border-border bg-surface-1/70 p-2.5">
            <Cover src={x.cover} name={x.track} size={52} />
            <a href={routes.track(x.uri)} className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium hover:text-[var(--accent)]">{x.track}</div>
              <div className="truncate text-xs text-text-faint">{x.artist}</div>
              <div className="truncate text-[11px] text-text-faint">
                {fmtInt(x.plays)} ascolti · fermo dal {fmtDate(x.last_day)}
              </div>
            </a>
            <div className="flex flex-col gap-1">
              <button aria-label="Mi piace" onClick={() => void vote(x, true)} className={`grid size-8 place-items-center rounded-full ${voted[x.uri] === true ? 'bg-good/20 text-good' : 'text-text-faint hover:bg-surface-2'}`}>
                <ThumbsUp size={15} />
              </button>
              <button aria-label="Non mi interessa" onClick={() => void vote(x, false)} className={`grid size-8 place-items-center rounded-full ${voted[x.uri] === false ? 'bg-bad/20 text-bad' : 'text-text-faint hover:bg-surface-2'}`}>
                <ThumbsDown size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => setV((x) => x + 1)}>
          <RefreshCw size={14} /> Nuovi suggerimenti
        </Button>
        <Button size="sm" onClick={() => void navigator.clipboard.writeText(ids.map((id) => `https://open.spotify.com/track/${id}`).join('\n'))}>
          Copia link per una playlist
        </Button>
      </div>
      <Explain>
        Bandit con Thompson sampling: ogni gruppo musicale della tua galassia ha una distribuzione Beta che si aggiorna con i tuoi 👍/👎. I
        suggerimenti mescolano esplorazione (gruppi poco provati) e sfruttamento (gruppi che ti piace ritrovare). Nessun dato lascia il dispositivo.
      </Explain>
    </div>
  );
}

export default function InsightsPage() {
  return (
    <div className="flex flex-col gap-14">
      <PageHeader kicker="Modelli" title="Cosa dicono i modelli" sub="Modelli statistici addestrati nel tuo browser sul tuo storico. Ogni risultato spiega come è stato calcolato." />
      <Section kicker="Riscoperta" title="Brani che amavi e hai dimenticato">
        <Rediscovery />
      </Section>
      <Section kicker="Le tue ere" title="Capitoli della tua vita musicale">
        <Eras />
      </Section>
      <Section kicker="Predizione degli skip" title="Il modello che prevede quando salti">
        <SkipModel />
      </Section>
      <Section kicker="Ciclo di vita degli artisti" title="Quanto durano le tue passioni">
        <Lifecycle />
      </Section>
      <p className="text-xs text-text-faint">
        {fmtPct(1)} locale: modelli calcolati con DuckDB e TypeScript nel browser. Le ere e i suggerimenti seguono il periodo selezionato in alto.
      </p>
    </div>
  );
}

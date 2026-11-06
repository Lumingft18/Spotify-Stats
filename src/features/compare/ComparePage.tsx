import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Upload, Users, ShieldCheck, ArrowRight } from 'lucide-react';
import { analyses, currentAnalysisId, type Analysis } from '../../lib/analyses';
import { useApp } from '../../lib/store';
import { fmtDate, fmtHours, fmtInt, fmtPct, fmtMonth, DOW } from '../../lib/format';
import { MOOD_HEX, moodLabel } from '../../lib/mood';
import { navigate, routes, useRoute } from '../../lib/router';
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Section, Spinner, cx } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { PlotChart, Plot } from '../../components/charts/PlotChart';
import { StoryButton } from '../../components/StoryButton';
import { compareWith, importPerson, loadOther, type Comparison, type Side } from './compareData';

const THEM = '#c7a3ff';
const ME = 'var(--accent)';

function Legend({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-4 text-xs text-text-muted">
      <span className="flex items-center gap-1.5">
        <i className="size-2.5 rounded-full" style={{ background: ME }} /> Tu
      </span>
      <span className="flex items-center gap-1.5">
        <i className="size-2.5 rounded-full" style={{ background: THEM }} /> {name}
      </span>
    </div>
  );
}

function Duo({ me, them, max, fmt }: { me: number; them: number; max: number; fmt: (v: number) => string }) {
  return (
    <div className="flex flex-col gap-1">
      {[
        { v: me, c: ME },
        { v: them, c: THEM },
      ].map((x, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, (x.v / (max || 1)) * 100)}%`, background: x.c }} />
          </div>
          <span className="num w-14 shrink-0 text-right text-xs text-text-muted">{fmt(x.v)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- sections ----------

function Hero({ c, name }: { c: Comparison; name: string }) {
  return (
    <Card className="grid gap-8 md:grid-cols-[auto_1fr]">
      <div className="flex flex-col items-start justify-center">
        <div className="text-xs text-text-faint">Tu e {name}</div>
        <div className="num text-7xl leading-none text-[var(--accent)]">{c.score}</div>
        <div className="text-sm text-text-muted">affinità su 100</div>
        <div className="mt-4">
          <StoryButton
            build={() => ({
              kicker: 'Affinità musicale',
              title: `Io e ${name}`,
              hero: { value: `${c.score}`, unit: 'su 100' },
              sections: [
                { title: 'Artisti in comune', rows: c.sharedArtists.slice(0, 5).map((s) => ({ label: s.artist })) },
                { title: 'Le nostre canzoni', rows: c.sharedTracks.slice(0, 4).map((t) => ({ label: t.track, sub: t.artist })) },
              ],
              filename: `affinita ${name}`,
            })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {c.parts.map((p) => (
          <div key={p.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{p.label}</span>
              <span className="num text-text-muted">{Math.round(p.value * 100)}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${p.value * 100}%` }} />
            </div>
            <div className="mt-0.5 text-xs text-text-faint">{p.desc}</div>
          </div>
        ))}
        <div className="text-xs text-text-faint">
          Affinità = media pesata (artisti 30%, generi 25%, brani, mood e abitudini 15% ciascuno). Artisti e generi: coefficiente di Bhattacharyya sulle quote
          di ascolto (1 = stesse proporzioni); abitudini: coseno del profilo settimanale. È un indice descrittivo, non una misura “vera”.
        </div>
      </div>
    </Card>
  );
}

const SIDE_ROWS: Array<{ k: keyof Side; label: string; fmt: (v: number) => string; scale?: (c: Comparison) => number }> = [
  { k: 'hours', label: 'Ore totali', fmt: (v) => fmtInt(v) },
  { k: 'hoursPerActiveDay', label: 'Ore nei giorni con musica', fmt: (v) => v.toFixed(1).replace('.', ',') },
  { k: 'artists', label: 'Artisti diversi', fmt: (v) => fmtInt(v) },
  { k: 'top10Share', label: 'Quota dei 10 artisti preferiti', fmt: fmtPct, scale: () => 1 },
  { k: 'novelty', label: 'Ascolto su brani appena scoperti', fmt: fmtPct, scale: () => 1 },
  { k: 'weekend', label: 'Nel weekend', fmt: fmtPct, scale: () => 1 },
  { k: 'night', label: 'Dopo mezzanotte (0–5)', fmt: fmtPct, scale: () => 1 },
  { k: 'skip', label: 'Brani saltati', fmt: fmtPct, scale: () => 1 },
  { k: 'shuffle', label: 'Riproduzione casuale', fmt: fmtPct, scale: () => 1 },
  { k: 'sessionMin', label: 'Sessione media (min)', fmt: (v) => fmtInt(v) },
  { k: 'valence', label: 'Positività media', fmt: (v) => fmtInt(v * 100), scale: () => 1 },
  { k: 'energy', label: 'Energia media', fmt: (v) => fmtInt(v * 100), scale: () => 1 },
];

function SideBySide({ c, name }: { c: Comparison; name: string }) {
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-text-muted">
          Tu: {fmtDate(c.me.from)} → {fmtDate(c.me.to)} · {name}: {fmtDate(c.them.from)} → {fmtDate(c.them.to)}
          {c.overlap && <> · periodo in comune {fmtDate(c.overlap.from)} → {fmtDate(c.overlap.to)}</>}
        </div>
        <Legend name={name} />
      </div>
      <div className="grid gap-x-10 gap-y-3 md:grid-cols-2">
        {SIDE_ROWS.filter((r) => c.me[r.k] != null && c.them[r.k] != null).map((r) => {
          const a = Number(c.me[r.k]);
          const b = Number(c.them[r.k]);
          return (
            <div key={r.k} className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-3">
              <span className="text-sm">{r.label}</span>
              <Duo me={a} them={b} max={r.scale ? r.scale(c) : Math.max(a, b)} fmt={r.fmt} />
            </div>
          );
        })}
        <div className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-3 text-sm">
          <span>Ora di punta · dispositivo</span>
          <span className="text-text-muted">
            <span style={{ color: ME }}>{c.me.peakHour}:00 · {c.me.topDevice}</span> · <span style={{ color: THEM }}>{c.them.peakHour}:00 · {c.them.topDevice}</span>
          </span>
        </div>
      </div>
    </Card>
  );
}

function Periods({ c, name }: { c: Comparison; name: string }) {
  const make = useCallback(
    () => ({
      height: 220,
      marginLeft: 40,
      x: { label: null, tickFormat: (d: number) => String(d) },
      y: { label: 'affinità artisti', domain: [0, 1], grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}` },
      marks: [Plot.barY(c.byYear, { x: 'year', y: 'affinity', fill: 'var(--accent)', rx: 3 })],
    }),
    [c.byYear],
  );
  const best = c.byYear.reduce<(typeof c.byYear)[number] | null>((b, y) => (!b || y.affinity > b.affinity ? y : b), null);
  const worst = c.byYear.reduce<(typeof c.byYear)[number] | null>((b, y) => (!b || y.affinity < b.affinity ? y : b), null);
  const ff = c.firstFound;
  const tot = ff.meFirst + ff.themFirst + ff.same;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <div className="mb-1 text-lg font-medium">
          {best && worst && best.year !== worst.year ? (
            <>
              Più vicini nel {best.year}, più lontani nel {worst.year}
            </>
          ) : (
            'Anno per anno'
          )}
        </div>
        <div className="mb-3 text-xs text-text-faint">Affinità sugli artisti dello stesso anno (anni in cui entrambi avete almeno 10 ore).</div>
        {c.byYear.length ? <PlotChart make={make} height={220} ariaLabel="Affinità per anno" /> : <Empty title="Nessun anno in comune" />}
      </Card>
      <Card>
        <div className="mb-1 text-lg font-medium">Chi l’ha scoperto prima</div>
        <div className="mb-3 text-xs text-text-faint">
          Artisti che ascoltate entrambi (almeno un’ora a testa), scoperti dopo l’inizio di entrambi gli storici. Differenza oltre 30 giorni.
        </div>
        {tot ? (
          <>
            <div className="flex h-3 overflow-hidden rounded-full">
              <div style={{ width: `${(ff.meFirst / tot) * 100}%`, background: ME }} />
              <div className="bg-surface-3" style={{ width: `${(ff.same / tot) * 100}%` }} />
              <div style={{ width: `${(ff.themFirst / tot) * 100}%`, background: THEM }} />
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-text-muted">
              <span>
                tu prima: <b className="num text-text">{fmtInt(ff.meFirst)}</b>
              </span>
              <span>insieme: {fmtInt(ff.same)}</span>
              <span>
                {name} prima: <b className="num text-text">{fmtInt(ff.themFirst)}</b>
              </span>
            </div>
            <div className="mt-4 flex flex-col gap-1.5">
              {ff.examples.map((e) => (
                <a key={e.artist} href={routes.artist(e.artist)} className="flex items-baseline justify-between gap-3 text-sm hover:text-[var(--accent)]">
                  <span className="truncate">{e.artist}</span>
                  <span className="num shrink-0 text-xs" style={{ color: e.leadDays > 0 ? ME : THEM }}>
                    {e.leadDays > 0 ? 'tu' : name} {Math.abs(e.leadDays) >= 365 ? `${(Math.abs(e.leadDays) / 365).toFixed(1).replace('.', ',')} anni` : `${fmtInt(Math.abs(e.leadDays))} giorni`} prima
                  </span>
                </a>
              ))}
            </div>
          </>
        ) : (
          <Empty title="Nessun artista scoperto da entrambi nel periodo in comune" />
        )}
      </Card>
    </div>
  );
}

function Taste({ c, name }: { c: Comparison; name: string }) {
  const max = Math.max(...c.sharedArtists.map((s) => Math.max(s.me, s.them)), 1);
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-lg font-medium">Artisti che vi uniscono</div>
          <Legend name={name} />
        </div>
        <div className="flex flex-col gap-3">
          {c.sharedArtists.map((s) => (
            <a key={s.artist} href={routes.artist(s.artist)} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 text-sm hover:text-[var(--accent)]">
              <span className="truncate">{s.artist}</span>
              <Duo me={s.me} them={s.them} max={max} fmt={fmtHours} />
            </a>
          ))}
          {!c.sharedArtists.length && <div className="text-sm text-text-faint">Nessun artista in comune.</div>}
        </div>
      </Card>
      <Card className="flex flex-col gap-5">
        <div>
          <div className="mb-2 text-sm font-medium">Generi in comune</div>
          <div className="flex flex-wrap gap-1.5">
            {c.tags.shared.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            {!c.tags.shared.length && <span className="text-sm text-text-faint">Pochi tag noti per confrontarli.</span>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[
            { who: 'I tuoi generi', list: c.tags.me, color: ME },
            { who: `I generi di ${name}`, list: c.tags.them, color: THEM },
          ].map((g) => (
            <div key={g.who}>
              <div className="mb-2 text-sm font-medium">{g.who}</div>
              <div className="flex flex-col gap-1">
                {g.list.slice(0, 8).map(([t, sh]) => (
                  <div key={t} className="flex items-center gap-2 text-xs">
                    <span className="w-24 truncate">{t}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (sh / (g.list[0]?.[1] || 1)) * 100)}%`, background: g.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function MoodCompare({ c, name }: { c: Comparison; name: string }) {
  const rows = c.moodMonthly.flatMap((m) => [
    ...(m.me != null ? [{ ym: new Date(`${m.ym}-15`), v: m.me, who: 'Tu' }] : []),
    ...(m.them != null ? [{ ym: new Date(`${m.ym}-15`), v: m.them, who: name }] : []),
  ]);
  const make = useCallback(
    () => ({
      height: 240,
      marginLeft: 40,
      x: { label: null, type: 'time' as const },
      y: { label: 'positività', domain: [0, 1], grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}` },
      color: { domain: ['Tu', name], range: ['var(--accent)', THEM] },
      marks: [Plot.lineY(rows, Plot.windowY({ k: 3 }, { x: 'ym', y: 'v', stroke: 'who', strokeWidth: 2, curve: 'monotone-x' }))],
    }),
    [rows, name],
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-lg font-medium">Il vostro mix di mood</div>
          <Legend name={name} />
        </div>
        <div className="flex flex-col gap-3">
          {c.moodMix.map((m) => (
            <div key={m.mood} className="grid grid-cols-[6.5rem_1fr] items-center gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                <i className="size-2.5 rounded-full" style={{ background: MOOD_HEX[m.mood] }} /> {moodLabel(m.mood)}
              </span>
              <Duo me={m.me} them={m.them} max={Math.max(...c.moodMix.map((x) => Math.max(x.me, x.them)))} fmt={fmtPct} />
            </div>
          ))}
        </div>
        <div className="mt-3 text-xs text-text-faint">
          Mood noto per il {fmtPct(c.me.moodKnown)} del tuo tempo e il {fmtPct(c.them.moodKnown)} di quello di {name} (dal catalogo condiviso e dai vostri
          arricchimenti).
        </div>
      </Card>
      <Card>
        <div className="mb-1 text-lg font-medium">Positività mese per mese</div>
        <div className="mb-3 text-xs text-text-faint">Media mobile su 3 mesi, nel periodo in comune; solo mesi con mood noto per almeno il 30% del tempo.</div>
        {rows.length > 6 ? <PlotChart make={make} height={240} ariaLabel="Positività per mese" /> : <Empty title="Troppo pochi mesi con mood noto" />}
      </Card>
    </div>
  );
}

function Habits({ c, name }: { c: Comparison; name: string }) {
  const rows = c.hours24.flatMap((h) => [
    { hour: h.hour, v: h.me, who: 'Tu' },
    { hour: h.hour, v: h.them, who: name },
  ]);
  const make = useCallback(
    () => ({
      height: 220,
      marginLeft: 40,
      x: { label: 'ora', ticks: [0, 3, 6, 9, 12, 15, 18, 21] },
      y: { label: 'quota del tempo', grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}%` },
      color: { domain: ['Tu', name], range: ['var(--accent)', THEM] },
      marks: [Plot.areaY(rows, { x: 'hour', y: 'v', fill: 'who', fillOpacity: 0.12, curve: 'monotone-x' }), Plot.lineY(rows, { x: 'hour', y: 'v', stroke: 'who', strokeWidth: 2, curve: 'monotone-x' })],
    }),
    [rows, name],
  );
  const night = (s: Side) => (s.night > 0.08 ? 'nottambulo' : s.peakHour < 12 ? 'mattiniero' : 'pomeridiano/serale');
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-lg font-medium">La vostra giornata musicale</div>
        <Legend name={name} />
      </div>
      <div className="mb-3 text-xs text-text-faint">
        Tu: picco alle {c.me.peakHour}:00 ({night(c.me)}) · {name}: picco alle {c.them.peakHour}:00 ({night(c.them)}). Abitudini simili al{' '}
        {fmtPct(c.parts.find((p) => p.key === 'habits')?.value ?? 0)} (profilo ora × {DOW.length} giorni).
      </div>
      <PlotChart make={make} height={220} ariaLabel="Ascolto per ora del giorno" />
    </Card>
  );
}

function TrackList({ items, empty }: { items: Array<{ uri: string; track: string; artist: string; cover: string | null; right: ReactNode }>; empty: string }) {
  if (!items.length) return <div className="text-sm text-text-faint">{empty}</div>;
  return (
    <div className="flex flex-col gap-2">
      {items.map((t) => (
        <a key={t.uri} href={routes.track(t.uri)} className="flex items-center gap-3 text-sm hover:text-[var(--accent)]">
          <Cover src={t.cover} name={t.track} size={36} />
          <div className="min-w-0 flex-1">
            <div className="truncate">{t.track}</div>
            <div className="truncate text-xs text-text-faint">{t.artist}</div>
          </div>
          <span className="num shrink-0 text-xs text-text-faint">{t.right}</span>
        </a>
      ))}
    </div>
  );
}

function Songs({ c, name }: { c: Comparison; name: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <div className="mb-3 text-lg font-medium">Le vostre canzoni</div>
        <TrackList
          items={c.sharedTracks.map((t) => ({ ...t, right: `${fmtHours(t.me)} / ${fmtHours(t.them)}` }))}
          empty="Nessun brano in comune tra i più ascoltati."
        />
      </Card>
      <Card>
        <div className="mb-3 text-lg font-medium">Da {name} potresti scoprire</div>
        <TrackList items={c.theirTracks.map((t) => ({ ...t, right: fmtHours(t.minutes) }))} empty="Nessun suggerimento." />
        <div className="mt-4 flex flex-wrap gap-1.5">
          {c.theirGems.map((g) => (
            <Badge key={g.artist}>{g.artist}</Badge>
          ))}
        </div>
      </Card>
      <Card>
        <div className="mb-3 text-lg font-medium">Tu potresti fargli sentire</div>
        <div className="flex flex-wrap gap-1.5">
          {c.myGems.map((g) => (
            <Badge key={g.artist} tone="accent">
              {g.artist} <span className="num text-text-faint">{fmtHours(g.minutes)}</span>
            </Badge>
          ))}
        </div>
        <div className="mt-4 text-xs text-text-faint">Artisti che ascolti molto e che {name} non ha mai ascoltato (meno di 5 minuti).</div>
      </Card>
    </div>
  );
}

// ---------- page ----------

function AddPerson({ onAdded }: { onAdded: (a: Analysis) => void }) {
  const [name, setName] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    try {
      onAdded(await importPerson(name, Array.from(files), setStep));
      setName('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStep(null);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2 font-medium">
        <Users size={18} className="text-[var(--accent)]" /> Aggiungi una persona
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (es. Davide)" aria-label="Nome della persona" className="h-10 w-56 rounded-full border border-border bg-surface-2 px-4 text-sm" />
        <Button variant="primary" onClick={() => input.current?.click()} disabled={!!step}>
          {step ? <Spinner size={14} /> : <Upload size={16} />} {step ?? 'Carica il suo ZIP'}
        </Button>
        <input ref={input} type="file" accept=".zip,.json" multiple hidden onChange={(e) => void add(e.target.files)} />
      </div>
      <div className="flex items-center gap-2 text-xs text-text-faint">
        <ShieldCheck size={13} className="text-good" /> Con il suo consenso. Diventa un’analisi salvata nel database locale: la ritrovi nell’elenco delle analisi e puoi
        eliminarla da lì.
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
    </Card>
  );
}

export default function ComparePage() {
  const current = useApp((s) => s.analysis);
  const [people, setPeople] = useState<Analysis[] | null>(null);
  // The person is in the URL (#/compare/<analysis id>): shareable and survives a reload.
  const sel = useRoute().path[1] ?? null;
  const setSel = (id: string) => navigate(`#/compare/${encodeURIComponent(id)}`);
  const [step, setStep] = useState<string | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = (await analyses.list()).filter((a) => a.id !== currentAnalysisId() && (a.rows ?? 0) > 0);
    setPeople(list);
    return list;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!sel) return;
    let alive = true;
    setCmp(null);
    setErr(null);
    (async () => {
      try {
        await loadOther(sel, (s) => alive && setStep(s));
        if (!alive) return;
        setStep('Confronto i vostri ascolti…');
        const name = people?.find((p) => p.id === sel)?.name ?? '';
        const c = await compareWith(name);
        if (alive) setCmp(c);
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setStep(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sel, people]);

  const them = people?.find((p) => p.id === sel);
  const name = them?.name ?? '';

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        kicker="Confronta"
        title={them ? `${current?.name ?? 'Tu'} e ${name}` : 'Tu e le altre persone'}
        sub="Affinità dei gusti, periodi, mood e abitudini a confronto, con le analisi salvate nel database locale."
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {people?.map((p) => (
            <button
              key={p.id}
              onClick={() => setSel(p.id)}
              className={cx(
                'flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors',
                sel === p.id ? 'border-[var(--accent)] bg-surface-2 text-text' : 'border-border bg-surface-1 text-text-muted hover:text-text',
              )}
            >
              {p.name} <span className="num text-xs text-text-faint">{fmtInt(p.rows ?? 0)}</span> <ArrowRight size={13} />
            </button>
          ))}
          {people && !people.length && <span className="text-sm text-text-faint">Nessun’altra analisi salvata: aggiungi una persona qui sotto.</span>}
        </div>
        <AddPerson
          onAdded={async (a) => {
            await refresh();
            setSel(a.id);
          }}
        />
      </div>

      {err && <ErrorNote>{err}</ErrorNote>}
      {step && (
        <div className="flex items-center gap-2 text-text-muted">
          <Spinner /> {step}
        </div>
      )}

      {cmp && them && (
        <>
          <Hero c={cmp} name={name} />
          <Section kicker="Uno accanto all’altro" title="Come ascoltate">
            <SideBySide c={cmp} name={name} />
          </Section>
          <Section kicker="Nel tempo" title="I vostri periodi">
            <Periods c={cmp} name={name} />
          </Section>
          <Section kicker="Gusti" title="Artisti e generi">
            <Taste c={cmp} name={name} />
          </Section>
          <Section kicker="Mood" title="Che suono hanno le vostre giornate">
            <MoodCompare c={cmp} name={name} />
          </Section>
          <Section kicker="Abitudini" title="Quando ascoltate">
            <Habits c={cmp} name={name} />
          </Section>
          <Section kicker="Brani" title="Le canzoni da condividere">
            <Songs c={cmp} name={name} />
          </Section>
          <p className="text-xs text-text-faint">
            {name}: {fmtMonth(cmp.them.from.slice(0, 7))} → {fmtMonth(cmp.them.to.slice(0, 7))}. Le statistiche usano gli storici completi; “periodo in comune” e
            anni solo dove entrambi avete ascolti.
          </p>
        </>
      )}
    </div>
  );
}

import { useCallback, useMemo, useState } from 'react';
import { useSql } from '../../data/useSql';
import { PlotChart, Plot } from '../../components/charts/PlotChart';
import { Card, Empty, Segmented, Skeleton } from '../../components/ui';
import { DOW, fmtDate, fmtHours, fmtMonth, fmtPct } from '../../lib/format';
import { MOODS, MOOD_HEX, MOOD_SQL, moodLabel, type Mood } from '../../lib/mood';
import { navigate, routes } from '../../lib/router';

type Grain = 'day' | 'week' | 'month';
type View = 'calendar' | 'trend' | 'moments';

const MOOD_ORDER: Mood[] = ['euforico', 'sereno', 'neutrale', 'arrabbiato', 'malinconico'];
const HAPPY = MOOD_HEX.euforico;
const SAD = MOOD_HEX.malinconico;

interface PeriodRow {
  period: string; // YYYY-MM-DD (start of period)
  mood: Mood;
  minutes: number;
}
interface IndexRow {
  period: string;
  valence: number;
  energy: number;
  minutes: number;
  coverage: number;
  top_track: string;
  top_artist: string;
}
interface DayRow {
  day: string;
  dominant: Mood;
  share: number;
  valence: number | null;
  minutes: number;
  top_track: string;
  top_artist: string;
}

const addGrain = (d: Date, g: Grain) => {
  const t = new Date(d);
  if (g === 'day') t.setUTCDate(t.getUTCDate() + 1);
  else if (g === 'week') t.setUTCDate(t.getUTCDate() + 7);
  else t.setUTCMonth(t.getUTCMonth() + 1);
  return t;
};
const periodLabel = (p: string, g: Grain) =>
  g === 'month' ? fmtMonth(p.slice(0, 7)) : g === 'week' ? `settimana del ${fmtDate(p)}` : fmtDate(p);
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Ascolto → umore: percentuale di tempo per stato d'animo e indice di positività, per giorno/settimana/mese. */
function Trend({ grain, relative }: { grain: Grain; relative: boolean }) {
  const stacked = useSql<PeriodRow>(`
    SELECT date_trunc('${grain}', day)::DATE::VARCHAR AS period, ${MOOD_SQL()} AS mood, sum(minutes) AS minutes
    FROM p WHERE valence IS NOT NULL GROUP BY ALL ORDER BY 1`);
  const index = useSql<IndexRow>(`
    SELECT date_trunc('${grain}', day)::DATE::VARCHAR AS period,
      sum(valence * minutes) FILTER (WHERE valence IS NOT NULL) / nullif(sum(minutes) FILTER (WHERE valence IS NOT NULL), 0) AS valence,
      sum(energy * minutes) FILTER (WHERE energy IS NOT NULL) / nullif(sum(minutes) FILTER (WHERE energy IS NOT NULL), 0) AS energy,
      sum(minutes) AS minutes,
      sum(minutes) FILTER (WHERE valence IS NOT NULL) / sum(minutes) AS coverage,
      arg_max(track, minutes) AS top_track, arg_max(artist, minutes) AS top_artist
    FROM p GROUP BY 1 HAVING sum(minutes) FILTER (WHERE valence IS NOT NULL) >= ${grain === 'day' ? 10 : 30} ORDER BY 1`);

  const baseline = useSql<{ v: number }>(`SELECT sum(valence * minutes) / sum(minutes) AS v FROM p WHERE valence IS NOT NULL`);
  const ref = relative ? baseline.data?.[0]?.v ?? 0.5 : 0.5;
  const rows = useMemo(
    () =>
      (stacked.data ?? []).map((r) => {
        const x1 = new Date(r.period + 'T00:00:00Z');
        return { ...r, x1, x2: addGrain(x1, grain) };
      }),
    [stacked.data, grain],
  );
  const idx = useMemo(
    () =>
      (index.data ?? [])
        .filter((r) => r.valence != null)
        .map((r) => {
          const x1 = new Date(r.period + 'T00:00:00Z');
          return { ...r, x1, x2: addGrain(x1, grain), d: r.valence - ref };
        }),
    [index.data, grain, ref],
  );

  const stackChart = useCallback(
    (width: number) => ({
      height: 230,
      marginLeft: 44,
      x: { type: 'utc' as const, label: null, ticks: width < 600 ? 4 : 8 },
      y: { label: 'tempo di ascolto', tickFormat: (v: number) => `${Math.round(v * 100)}%`, grid: true },
      color: { domain: MOOD_ORDER, range: MOOD_ORDER.map((m) => MOOD_HEX[m]), tickFormat: (m: Mood) => moodLabel(m), legend: true },
      marks: [
        Plot.rectY(
          rows,
          Plot.stackY({ offset: 'normalize', order: MOOD_ORDER, x1: 'x1', x2: 'x2', y: 'minutes', fill: 'mood', insetLeft: grain === 'day' ? 0 : 0.5, insetRight: grain === 'day' ? 0 : 0.5 } as never),
        ),
        Plot.tip(
          rows,
          Plot.pointerX(
            Plot.stackY({
              offset: 'normalize',
              order: MOOD_ORDER,
              x: (d: { x1: Date; x2: Date }) => new Date((d.x1.getTime() + d.x2.getTime()) / 2),
              y: 'minutes',
              fill: 'mood',
              title: (d: PeriodRow) => `${periodLabel(d.period, grain)}\n${moodLabel(d.mood)}: ${fmtHours(d.minutes)}`,
            } as never),
          ),
        ),
      ],
    }),
    [rows, grain],
  );

  const indexChart = useCallback(
    (width: number) => ({
      height: 200,
      marginLeft: 44,
      x: { type: 'utc' as const, label: null, ticks: width < 600 ? 4 : 8 },
      y: {
        label: relative ? '← più triste del solito · più felice del solito →' : '← più triste · più felice →',
        grid: true,
        tickFormat: (v: number) => (v === 0 ? (relative ? 'media' : 'neutro') : v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)),
      },
      marks: [
        Plot.rectY(idx, {
          x1: 'x1',
          x2: 'x2',
          y1: 0,
          y2: 'd',
          fill: (r: { d: number }) => (r.d >= 0 ? HAPPY : SAD),
          fillOpacity: (r: { coverage: number }) => 0.35 + 0.65 * Math.min(1, r.coverage),
          insetLeft: grain === 'day' ? 0 : 0.5,
          insetRight: grain === 'day' ? 0 : 0.5,
        }),
        Plot.ruleY([0], { stroke: 'var(--color-text-faint)' }),
        Plot.lineY(
          idx,
          Plot.windowY(
            { k: grain === 'day' ? 14 : grain === 'week' ? 4 : 3, anchor: 'middle' },
            { x: (r: { x1: Date; x2: Date }) => new Date((r.x1.getTime() + r.x2.getTime()) / 2), y: 'd', stroke: 'var(--color-text)', strokeWidth: 1.5, strokeOpacity: 0.7, curve: 'monotone-x' },
          ),
        ),
        Plot.tip(
          idx,
          Plot.pointerX({
            x: (r: { x1: Date; x2: Date }) => new Date((r.x1.getTime() + r.x2.getTime()) / 2),
            y: 'd',
            title: (r: IndexRow & { d: number }) =>
              `${cap(periodLabel(r.period, grain))}\n${r.d >= 0 ? 'più felice' : 'più triste'} ${relative ? 'della tua media' : 'del neutro'} (valence ${r.valence.toFixed(2)})\nenergia ${r.energy?.toFixed(2) ?? '—'} · ${fmtHours(r.minutes)}\nin testa: ${r.top_track} — ${r.top_artist}`,
          }),
        ),
      ],
    }),
    [idx, grain, relative],
  );

  if (stacked.loading && !stacked.data) return <Skeleton className="h-[460px]" />;
  if (!rows.length) return <Empty title="Nessun dato sul mood nel periodo">Attiva le audio features o la stima AI.</Empty>;

  const sorted = [...idx].filter((r) => r.coverage > 0.3).sort((a, b) => a.d - b.d);
  const saddest = sorted[0];
  const happiest = sorted[sorted.length - 1];

  return (
    <div className="flex flex-col gap-5">
      {saddest && happiest && saddest !== happiest && (
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            onClick={() => navigate(routes.ask(`Cosa ascoltavo nella ${periodLabel(happiest.period, grain)} e perché era così allegro?`))}
            className="rounded-2xl border border-border bg-surface-1 p-4 text-left transition-colors hover:bg-surface-2"
            style={{ borderLeft: `4px solid ${HAPPY}` }}
          >
            <div className="text-xs text-text-faint">Periodo più felice</div>
            <div className="mt-0.5 font-medium">{cap(periodLabel(happiest.period, grain))}</div>
            <div className="mt-1 truncate text-sm text-text-muted">
              valence {happiest.valence.toFixed(2)} · in testa “{happiest.top_track}” di {happiest.top_artist}
            </div>
          </button>
          <button
            onClick={() => navigate(routes.ask(`Cosa ascoltavo nella ${periodLabel(saddest.period, grain)} e perché era così malinconico?`))}
            className="rounded-2xl border border-border bg-surface-1 p-4 text-left transition-colors hover:bg-surface-2"
            style={{ borderLeft: `4px solid ${SAD}` }}
          >
            <div className="text-xs text-text-faint">Periodo più triste</div>
            <div className="mt-0.5 font-medium">{cap(periodLabel(saddest.period, grain))}</div>
            <div className="mt-1 truncate text-sm text-text-muted">
              valence {saddest.valence.toFixed(2)} · in testa “{saddest.top_track}” di {saddest.top_artist}
            </div>
          </button>
        </div>
      )}
      <div>
        <div className="mb-1 text-sm text-text-muted">Felice o triste? Scostamento della positività media {relative ? `dalla tua media (${ref.toFixed(2)})` : 'dal neutro (0,50)'} · linea = media mobile</div>
        <PlotChart make={indexChart} height={200} ariaLabel="Indice di umore per periodo: barre sopra lo zero più felice, sotto più triste" />
      </div>
      <div>
        <div className="mb-1 text-sm text-text-muted">Come si divide il tempo tra gli stati d’animo</div>
        <PlotChart make={stackChart} height={230} ariaLabel="Quota di tempo per stato d'animo in ogni periodo" />
      </div>
    </div>
  );
}

/** Calendario: ogni giorno colorato con lo stato d'animo prevalente; intensità = minuti ascoltati. */
function MoodCalendar() {
  const days = useSql<DayRow>(`
    WITH d AS (
      SELECT day, ${MOOD_SQL()} AS mood, sum(minutes) AS m FROM p WHERE valence IS NOT NULL GROUP BY ALL
    ), t AS (
      SELECT day, sum(minutes) AS minutes, sum(valence * minutes) FILTER (WHERE valence IS NOT NULL) / nullif(sum(minutes) FILTER (WHERE valence IS NOT NULL), 0) AS valence,
             arg_max(track, minutes) AS top_track, arg_max(artist, minutes) AS top_artist
      FROM p GROUP BY day
    )
    SELECT d.day::VARCHAR AS day, arg_max(d.mood, d.m) AS dominant, max(d.m) / sum(d.m) AS share,
           any_value(t.valence) AS valence, any_value(t.minutes) AS minutes, any_value(t.top_track) AS top_track, any_value(t.top_artist) AS top_artist
    FROM d JOIN t USING (day) GROUP BY d.day ORDER BY d.day`);
  const years = useMemo(() => Array.from(new Set((days.data ?? []).map((d) => d.day.slice(0, 4)))).sort().reverse(), [days.data]);
  const [year, setYear] = useState<string | null>(null);
  const y = year && years.includes(year) ? year : years[0];
  const data = useMemo(() => {
    const rows = (days.data ?? []).filter((d) => d.day.startsWith(y ?? ''));
    const max = Math.max(1, ...rows.map((r) => r.minutes));
    return rows.map((r) => ({ ...r, date: new Date(r.day + 'T00:00:00Z'), op: 0.55 + 0.45 * Math.sqrt(r.minutes / max) }));
  }, [days.data, y]);

  const week = (d: Date) => {
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const startDow = (new Date(start).getUTCDay() + 6) % 7;
    return Math.floor(((d.getTime() - start) / 86_400_000 + startDow) / 7);
  };

  const make = useCallback(
    () => ({
      height: 170,
      marginLeft: 30,
      marginTop: 22,
      padding: 0.1,
      x: { axis: null },
      y: { tickFormat: (d: number) => ['L', 'M', 'M', 'G', 'V', 'S', 'D'][d], tickSize: 0, domain: [0, 1, 2, 3, 4, 5, 6] },
      marks: [
        Plot.cell(data, {
          x: (d: { date: Date }) => week(d.date),
          y: (d: { date: Date }) => (d.date.getUTCDay() + 6) % 7,
          fill: (d: DayRow) => MOOD_HEX[d.dominant],
          fillOpacity: 'op',
          rx: 2,
        }),
        Plot.text(
          Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(Number(y), m, 1))),
          {
            x: (d: Date) => week(d),
            y: -1,
            text: (d: Date) => ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'][d.getUTCMonth()],
            textAnchor: 'start',
            dy: -10,
            fill: 'var(--color-text-faint)',
          } as never,
        ),
        Plot.tip(
          data,
          Plot.pointer({
            x: (d: { date: Date }) => week(d.date),
            y: (d: { date: Date }) => (d.date.getUTCDay() + 6) % 7,
            title: (d: DayRow) =>
              `${fmtDate(d.day)}\n${moodLabel(d.dominant)} (${fmtPct(d.share)} del tempo)\n${fmtHours(d.minutes)} · valence ${d.valence?.toFixed(2) ?? '—'}\n“${d.top_track}” — ${d.top_artist}`,
          }),
        ),
      ],
    }),
    [data, y],
  );

  if (days.loading && !days.data) return <Skeleton className="h-48" />;
  if (!data.length) return <Empty title="Nessun dato sul mood nel periodo" />;

  const counts = MOODS.map((m) => ({ ...m, n: data.filter((d) => d.dominant === m.id).length }));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {years.map((yy) => (
            <button key={yy} onClick={() => setYear(yy)} className={`h-7 rounded-full px-3 text-xs ${yy === y ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2'}`}>
              {yy}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-text-muted">
          {counts.map((c) => (
            <span key={c.id} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: MOOD_HEX[c.id] }} />
              {c.label} <span className="num text-text-faint">{c.n} gg</span>
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <PlotChart make={make} height={170} ariaLabel={`Calendario dell'umore ${y}: ogni giorno colorato con lo stato d'animo prevalente`} />
        </div>
      </div>
      <div className="mt-2 text-xs text-text-faint">Colore = stato d’animo prevalente del giorno · intensità = quanto hai ascoltato.</div>
    </div>
  );
}

/** Momenti: positività media per ora × giorno della settimana. */
function Moments({ relative }: { relative: boolean }) {
  const rows = useSql<{ dow: number; hour: number; valence: number; minutes: number }>(`
    SELECT dow, hour, sum(valence * minutes) / sum(minutes) AS valence, sum(minutes) AS minutes
    FROM p WHERE valence IS NOT NULL GROUP BY ALL HAVING sum(minutes) >= 20`);
  const parts = useSql<{ part: string; ord: number; valence: number; energy: number; minutes: number }>(`
    SELECT CASE WHEN hour < 6 THEN 'Notte' WHEN hour < 12 THEN 'Mattina' WHEN hour < 18 THEN 'Pomeriggio' ELSE 'Sera' END AS part,
           min(CASE WHEN hour < 6 THEN 0 WHEN hour < 12 THEN 1 WHEN hour < 18 THEN 2 ELSE 3 END) AS ord,
           sum(valence * minutes) / sum(minutes) AS valence, sum(energy * minutes) / sum(minutes) AS energy, sum(minutes) AS minutes
    FROM p WHERE valence IS NOT NULL GROUP BY 1 ORDER BY 2`);
  const data = useMemo(() => rows.data ?? [], [rows.data]);
  const totalMin = data.reduce((a, d) => a + d.minutes, 0) || 1;
  const mean = relative ? data.reduce((a, d) => a + d.valence * d.minutes, 0) / totalMin : 0.5;
  const vmin = Math.min(mean - 0.01, ...data.map((d) => d.valence));
  const vmax = Math.max(mean + 0.01, ...data.map((d) => d.valence));
  const verdict = useCallback(
    (v: number) => (v - mean > 0.015 ? (relative ? 'Più felice del solito' : 'Più felice') : v - mean < -0.015 ? (relative ? 'Più triste del solito' : 'Più triste') : 'Nella media'),
    [mean, relative],
  );
  const make = useCallback(
    () => ({
      height: 250,
      marginLeft: 36,
      padding: 0.06,
      x: { label: null, tickFormat: (h: number) => (h % 3 === 0 ? `${h}` : '') },
      y: { label: null, tickFormat: (d: number) => DOW[d - 1], domain: [1, 2, 3, 4, 5, 6, 7] },
      color: { type: 'linear' as const, domain: [vmin, mean, vmax], range: [SAD, '#2a2e38', HAPPY], legend: false },
      marks: [
        Plot.cell(data, { x: 'hour', y: 'dow', fill: 'valence', rx: 3 }),
        Plot.tip(
          data,
          Plot.pointer({
            x: 'hour',
            y: 'dow',
            title: (d: { dow: number; hour: number; valence: number; minutes: number }) =>
              `${DOW[d.dow - 1]} ore ${d.hour}:00\n${verdict(d.valence)} (valence ${d.valence.toFixed(2)})\n${fmtHours(d.minutes)} in totale`,
          }),
        ),
      ],
    }),
    [data, vmin, vmax, mean, verdict],
  );
  if (rows.loading && !rows.data) return <Skeleton className="h-60" />;
  if (!data.length) return <Empty title="Nessun dato sul mood nel periodo" />;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(parts.data ?? []).map((p) => (
          <div key={p.part} className="rounded-2xl border border-border bg-surface-1 p-3" style={{ borderTop: `3px solid ${p.valence - mean > 0.015 ? HAPPY : p.valence - mean < -0.015 ? SAD : '#5b6170'}` }}>
            <div className="text-xs text-text-faint">{p.part}</div>
            <div className="mt-1 font-medium">{verdict(p.valence)}</div>
            <div className="num text-xs text-text-muted">
              valence {p.valence.toFixed(2)} · energia {p.energy.toFixed(2)}
            </div>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 flex items-center gap-3 text-xs text-text-muted">
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: SAD }} /> più triste</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: '#2a2e38' }} /> {relative ? `la tua media (${mean.toFixed(2)})` : 'neutro'}</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: HAPPY }} /> più felice</span>
        </div>
        <PlotChart make={make} height={250} ariaLabel="Positività media per ora e giorno della settimana" />
      </div>
    </div>
  );
}

export function MoodTimeline() {
  const [view, setView] = useState<View>('calendar');
  const [grain, setGrain] = useState<Grain>('week');
  const [ref, setRef] = useState<'mine' | 'neutral'>('mine');
  return (
    <Card className="flex flex-col gap-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'calendar', label: 'Giorno per giorno' },
            { value: 'trend', label: 'Andamento' },
            { value: 'moments', label: 'Momenti della settimana' },
          ]}
        />
        <div className="flex flex-wrap gap-2">
        {view !== 'calendar' && (
          <Segmented
            value={ref}
            onChange={setRef}
            options={[
              { value: 'mine', label: 'Rispetto alla mia media' },
              { value: 'neutral', label: 'Rispetto al neutro' },
            ]}
          />
        )}
        {view === 'trend' && (
          <Segmented
            value={grain}
            onChange={setGrain}
            options={[
              { value: 'day', label: 'Giorni' },
              { value: 'week', label: 'Settimane' },
              { value: 'month', label: 'Mesi' },
            ]}
          />
        )}
        </div>
      </div>
      {view === 'calendar' && <MoodCalendar />}
      {view === 'trend' && <Trend grain={grain} relative={ref === 'mine'} />}
      {view === 'moments' && <Moments relative={ref === 'mine'} />}
      <p className="text-xs text-text-faint">
        L’umore è dedotto da ciò che ascoltavi (positività ed energia dei brani, pesate per minuti), non da come ti sentivi davvero: è un indizio, non una diagnosi.
      </p>
    </Card>
  );
}

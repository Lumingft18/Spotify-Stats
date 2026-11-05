import { useCallback, useMemo, useState } from 'react';
import { useSql, useAsync } from '../../data/useSql';
import { HOUR_DOW_SQL, DAILY_SQL } from '../../data/queries';
import { countryName, DOW_LONG, fmtDuration, fmtHours, fmtInt, fmtPct, fmtDate } from '../../lib/format';
import { sessionStats } from '../../ml/models';
import { Card, PageHeader, Section, Segmented, Skeleton, Stat, Meter } from '../../components/ui';
import { HourDowHeatmap } from '../../components/charts/common';
import { PlotChart, Plot } from '../../components/charts/PlotChart';
import { StoryButton } from '../../components/StoryButton';
import { periodLabel } from '../../lib/storyCard';
import { useApp } from '../../lib/store';

function Calendar({ days }: { days: Array<{ day: string; minutes: number }> }) {
  const years = useMemo(() => Array.from(new Set(days.map((d) => d.day.slice(0, 4)))).sort().reverse(), [days]);
  const [year, setYear] = useState<string | null>(null);
  const y = year ?? years[0];
  const data = useMemo(() => days.filter((d) => d.day.startsWith(y)).map((d) => ({ date: new Date(d.day + 'T00:00:00Z'), minutes: d.minutes })), [days, y]);
  const make = useCallback(
    () => ({
      height: 150,
      marginLeft: 30,
      marginTop: 18,
      padding: 0.12,
      x: { axis: null },
      y: { tickFormat: (d: number) => ['L', 'M', 'M', 'G', 'V', 'S', 'D'][d], tickSize: 0, domain: [0, 1, 2, 3, 4, 5, 6] },
      color: { type: 'sqrt' as const, range: ['#1d2230', '#e8b94a'], interpolate: 'hcl' as const },
      marks: [
        Plot.cell(data, {
          x: (d: { date: Date }) => {
            const start = Date.UTC(d.date.getUTCFullYear(), 0, 1);
            const startDow = (new Date(start).getUTCDay() + 6) % 7;
            return Math.floor(((d.date.getTime() - start) / 86_400_000 + startDow) / 7);
          },
          y: (d: { date: Date }) => (d.date.getUTCDay() + 6) % 7,
          fill: 'minutes',
          rx: 2,
          title: (d: { date: Date; minutes: number }) => `${fmtDate(d.date.toISOString().slice(0, 10))}\n${fmtHours(d.minutes)}`,
        }),
        Plot.text(
          Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(Number(y), m, 1))),
          {
            x: (d: Date) => {
              const start = Date.UTC(d.getUTCFullYear(), 0, 1);
              const startDow = (new Date(start).getUTCDay() + 6) % 7;
              return Math.floor(((d.getTime() - start) / 86_400_000 + startDow) / 7);
            },
            y: -1,
            text: (d: Date) => ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'][d.getUTCMonth()],
            textAnchor: 'start',
            frameAnchor: 'top',
            dy: -10,
            fill: 'var(--color-text-faint)',
          } as never,
        ),
      ],
    }),
    [data, y],
  );
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1">
        {years.map((yy) => (
          <button
            key={yy}
            onClick={() => setYear(yy)}
            className={`h-7 rounded-full px-3 text-xs ${yy === y ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2'}`}
          >
            {yy}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <PlotChart make={make} height={150} ariaLabel={`Calendario degli ascolti ${y}`} />
        </div>
      </div>
    </div>
  );
}

export default function TimePage() {
  const heat = useSql<{ dow: number; hour: number; avg_minutes: number }>(HOUR_DOW_SQL);
  const daily = useSql<{ day: string; minutes: number }>(DAILY_SQL);
  const platforms = useSql<{ platform: string; minutes: number; skip: number }>(
    `SELECT platform, sum(minutes) AS minutes, avg(skipped::INT) AS skip FROM p GROUP BY 1 ORDER BY 2 DESC`,
  );
  const countries = useSql<{ country: string; minutes: number; days: number }>(
    `SELECT country, sum(minutes) AS minutes, count(DISTINCT day) AS days FROM p GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
  );
  const reasons = useSql<{ reason_end: string; n: number }>(`SELECT reason_end, count(*) AS n FROM p GROUP BY 1 ORDER BY 2 DESC LIMIT 7`);
  const skipBuckets = useSql<{ bucket: string; n: number; ord: number }>(`
    SELECT CASE WHEN ms_played < 3000 THEN '< 3 s' WHEN ms_played < 10000 THEN '3–10 s' WHEN ms_played < 30000 THEN '10–30 s'
                WHEN ms_played < 60000 THEN '30–60 s' WHEN ms_played < 120000 THEN '1–2 min' ELSE '> 2 min' END bucket,
           min(ms_played) AS ord, count(*) AS n
    FROM p WHERE skipped GROUP BY 1 ORDER BY ord`);
  const sess = useAsync(sessionStats);
  const [mode, setMode] = useState<'avg' | 'tot'>('avg');

  const heatRows = useMemo(
    () => (heat.data ?? []).map((d) => ({ dow: d.dow, hour: d.hour, value: mode === 'avg' ? d.avg_minutes : (d as unknown as { minutes: number }).minutes })),
    [heat.data, mode],
  );
  const peak = heatRows.reduce<{ dow: number; hour: number; value: number } | null>((a, b) => (!a || b.value > a.value ? b : a), null);
  const totalPlat = (platforms.data ?? []).reduce((a, b) => a + b.minutes, 0);
  const skipTotal = (skipBuckets.data ?? []).reduce((a, b) => a + b.n, 0);
  const range = useApp((st) => st.range);
  const buildStory = () => {
    if (!heat.data || !peak) return null;
    const byHour = Array.from({ length: 24 }, (_, h) => heat.data!.filter((d) => d.hour === h).reduce((a, b) => a + b.avg_minutes, 0));
    const peakHour = byHour.indexOf(Math.max(...byHour));
    const sv = sess.value;
    return {
      kicker: `Quando ascolto · ${periodLabel(range)}`,
      title: `${DOW_LONG[peak.dow - 1]} alle ${peak.hour}:00`,
      subtitle: 'il mio momento musicale della settimana',
      stats: sv
        ? [
            { label: 'Sessioni', value: fmtInt(sv.sessions) },
            { label: 'Durata media', value: fmtDuration(sv.avgMinutes) },
            ...(sv.longest ? [{ label: 'Sessione record', value: fmtDuration(sv.longest.minutes) }] : []),
            { label: 'Ora di punta', value: `${peakHour}:00` },
          ]
        : [{ label: 'Ora di punta', value: `${peakHour}:00` }],
      bars: { title: 'Ascolto per ora del giorno', values: byHour, from: '0:00', to: '23:00', highlight: peakHour },
      sections: [
        {
          title: 'Da dove ascolto',
          rows: (platforms.data ?? []).slice(0, 4).map((p) => ({ label: p.platform, value: fmtPct(p.minutes / Math.max(1, totalPlat)) })),
        },
      ],
      filename: `tempo ${periodLabel(range)}`,
    };
  };

  const bucketChart = useCallback(
    () => ({
      height: 200,
      marginLeft: 40,
      x: { label: null, domain: (skipBuckets.data ?? []).map((d) => d.bucket) },
      y: { label: '% dei salti', grid: true, tickFormat: (v: number) => `${Math.round(v * 100)}%` },
      marks: [Plot.barY(skipBuckets.data ?? [], { x: 'bucket', y: (d: { n: number }) => d.n / Math.max(1, skipTotal), fill: 'var(--accent)', rx: 3 })],
    }),
    [skipBuckets.data, skipTotal],
  );

  return (
    <div className="flex flex-col gap-12">
      <PageHeader kicker="Tempo" title="Quando ascolti" sub="Ritmi, abitudini e sessioni. Le ore sono nel tuo fuso orario." right={<StoryButton build={buildStory} />} />

      <Section
        kicker="Settimana tipo"
        title={peak ? <>Il tuo momento: {DOW_LONG[peak.dow - 1]} alle {peak.hour}:00</> : 'Ora × giorno'}
        action={
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'avg', label: 'Media' },
              { value: 'tot', label: 'Totale' },
            ]}
          />
        }
      >
        <Card className="p-4">{heat.data ? <HourDowHeatmap rows={heatRows} valueLabel={mode === 'avg' ? 'minuti medi' : 'minuti totali'} height={260} /> : <Skeleton className="h-60" />}</Card>
      </Section>

      <Section kicker="Calendario" title="Ogni giorno, a colpo d’occhio">
        <Card className="p-4">{daily.data ? <Calendar days={daily.data} /> : <Skeleton className="h-40" />}</Card>
      </Section>

      <Section kicker="Sessioni" title="Come ascolti, una sessione alla volta">
        {sess.value ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
            <div className="grid grid-cols-2 gap-6">
              <Stat label="Sessioni" value={fmtInt(sess.value.sessions)} sub="pausa > 30 min = nuova sessione" />
              <Stat label="Durata media" value={fmtDuration(sess.value.avgMinutes)} sub={`${Math.round(sess.value.avgTracks)} brani`} />
              {sess.value.longest && (
                <Stat label="Sessione record" value={fmtDuration(sess.value.longest.minutes)} sub={`${fmtDate(sess.value.longest.day)} · ${sess.value.longest.tracks} brani`} />
              )}
            </div>
            <Card className="flex flex-col gap-3">
              {sess.value.kinds.map((k) => (
                <div key={k.kind}>
                  <div className="mb-1 flex justify-between gap-2 text-sm">
                    <span>
                      <span className="font-medium">{k.kind}</span> <span className="text-text-faint">— {k.desc}</span>
                    </span>
                    <span className="num text-text-muted">{fmtPct(k.n / Math.max(1, sess.value!.kinds.reduce((a, b) => a + b.n, 0)))}</span>
                  </div>
                  <Meter value={k.n} max={Math.max(...sess.value!.kinds.map((x) => x.n))} />
                </div>
              ))}
            </Card>
          </div>
        ) : (
          <Skeleton className="h-40" />
        )}
      </Section>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section kicker="Salti" title="Quando salti, lo fai in fretta?">
          <Card className="p-4">{skipBuckets.data ? <PlotChart make={bucketChart} height={200} ariaLabel="Distribuzione dei salti per secondi ascoltati" /> : <Skeleton className="h-48" />}</Card>
        </Section>
        <Section kicker="Fine ascolto" title="Perché un brano finisce">
          <Card className="flex flex-col gap-3">
            {(reasons.data ?? []).map((r) => (
              <div key={r.reason_end}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="capitalize">{r.reason_end}</span>
                  <span className="num text-text-muted">{fmtInt(r.n)}</span>
                </div>
                <Meter value={r.n} max={reasons.data![0].n} />
              </div>
            ))}
          </Card>
        </Section>
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section kicker="Dispositivi" title="Da dove ascolti">
          <Card className="flex flex-col gap-3">
            {(platforms.data ?? []).map((p) => (
              <div key={p.platform}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{p.platform}</span>
                  <span className="num text-text-muted">
                    {fmtPct(p.minutes / Math.max(1, totalPlat))} · skip {fmtPct(p.skip)}
                  </span>
                </div>
                <Meter value={p.minutes} max={platforms.data![0].minutes} />
              </div>
            ))}
          </Card>
        </Section>
        <Section kicker="Paesi" title="Dove eri connesso">
          <Card className="flex flex-col gap-2">
            {(countries.data ?? []).map((c) => (
              <div key={c.country} className="flex items-center justify-between gap-3 text-sm">
                <span>{countryName(c.country)}</span>
                <span className="num text-text-muted">
                  {fmtHours(c.minutes)} · {fmtInt(c.days)} giorni
                </span>
              </div>
            ))}
          </Card>
        </Section>
      </div>
    </div>
  );
}

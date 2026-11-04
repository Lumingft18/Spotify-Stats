import { useCallback, useMemo } from 'react';
import { ArrowRight, Sparkles, BookOpen, ImageOff } from 'lucide-react';
import { useSql, useSqlOne, useAsync } from '../../data/useSql';
import { KPI_SQL, KPI_WINDOW_SQL, MONTHLY_SQL, topSql, type Kpi, type TopRow } from '../../data/queries';
import { useApp } from '../../lib/store';
import { addDays, daysBetween, fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { routes } from '../../lib/router';
import { useAccentFrom } from '../../lib/color';
import { Card, Delta, Section, Skeleton, Stat, Badge, Button } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { EntityList } from '../../components/EntityList';
import { Sparkline } from '../../components/charts/Sparkline';
import { PlotChart, Plot } from '../../components/charts/PlotChart';
import { computeInsights } from './insights';
import { detectEras } from '../../ml/models';

function usePrevWindow(k: Kpi | null) {
  const range = useApp((s) => s.range);
  const bounds = useApp((s) => s.bounds);
  const from = range.from ?? null;
  const to = range.to ?? bounds?.max ?? null;
  const len = from && to ? daysBetween(from, to) : 0;
  const prevFrom = from ? addDays(from, -len) : null;
  const prevTo = from ? addDays(from, -1) : null;
  const ok = !!(from && bounds && prevFrom && prevFrom >= addDays(bounds.min, -1));
  const prev = useSqlOne<{ minutes: number; plays: number; artists: number; tracks: number }>(
    ok && k ? KPI_WINDOW_SQL : null,
    [prevFrom, prevTo],
  );
  const d = (a: number | undefined, b: number | undefined) => (a != null && b ? a / b - 1 : null);
  return ok && prev.row
    ? {
        minutes: d(k?.minutes, prev.row.minutes),
        plays: d(k?.plays, prev.row.plays),
        artists: d(k?.artists, prev.row.artists),
        tracks: d(k?.tracks, prev.row.tracks),
      }
    : null;
}

export function Overview() {
  const kpi = useSqlOne<Kpi>(KPI_SQL);
  const monthly = useSql<{ ym: string; minutes: number }>(MONTHLY_SQL);
  const topArtists = useSql<TopRow>(topSql('artists', 'minutes', 5));
  const topTracks = useSql<TopRow>(topSql('tracks', 'minutes', 5));
  const topAlbums = useSql<TopRow>(topSql('albums', 'minutes', 6));
  const insights = useAsync(computeInsights);
  const eras = useAsync(() => detectEras(6));
  const coverage = useSqlOne<{ covers: number; total: number }>(
    `SELECT count(*) FILTER (WHERE m.cover IS NOT NULL AND m.cover <> '') AS covers, count(*) AS total FROM tracks t LEFT JOIN meta m USING (uri) WHERE t.plays > 0`,
  );
  const deltas = usePrevWindow(kpi.row);
  const k = kpi.row;
  const hero = topArtists.data?.[0];
  useAccentFrom(hero?.cover);

  const months = useMemo(() => monthly.data ?? [], [monthly.data]);
  const peakMonth = months.reduce<{ ym: string; minutes: number } | null>((a, b) => (!a || b.minutes > a.minutes ? b : a), null);
  const days = k?.first_day && k.last_day ? daysBetween(k.first_day, k.last_day) : 0;

  const chart = useCallback(
    (width: number) => ({
      height: 200,
      marginLeft: 40,
      x: { type: 'utc' as const, label: null, ticks: width < 600 ? 4 : 8 },
      y: { label: 'ore', grid: true, tickFormat: (v: number) => `${v}` },
      marks: [
        Plot.areaY(months, { x: (d: { ym: string }) => new Date(d.ym + '-01'), y: (d: { minutes: number }) => d.minutes / 60, fill: 'var(--accent)', fillOpacity: 0.14, curve: 'monotone-x' }),
        Plot.lineY(months, { x: (d: { ym: string }) => new Date(d.ym + '-01'), y: (d: { minutes: number }) => d.minutes / 60, stroke: 'var(--accent)', strokeWidth: 2, curve: 'monotone-x' }),
        Plot.tip(months, Plot.pointerX({ x: (d: { ym: string }) => new Date(d.ym + '-01'), y: (d: { minutes: number }) => d.minutes / 60, title: (d: { ym: string; minutes: number }) => `${fmtMonth(d.ym)}\n${fmtHours(d.minutes)}` })),
      ],
    }),
    [months],
  );

  const coverPct = coverage.row && coverage.row.total ? coverage.row.covers / coverage.row.total : 1;

  return (
    <div className="flex flex-col gap-12">
      {/* Hero */}
      <section className="grid items-end gap-8 md:grid-cols-[1.4fr_1fr]">
        <div className="animate-rise">
          <div className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-text-faint">
            {k?.first_day ? `${fmtDate(k.first_day)} — ${fmtDate(k.last_day)}` : ' '}
          </div>
          {k ? (
            <>
              <h1 className="display text-7xl leading-none md:text-8xl">
                <span className="num font-sans text-[0.82em] font-medium tracking-tight">{fmtInt(k.minutes / 60)}</span> ore
              </h1>
              <p className="mt-3 text-lg text-text-muted">
                di musica in {fmtInt(days)} giorni · {fmtHours(k.minutes / Math.max(1, days))} al giorno in media
              </p>
              <div className="mt-2">
                <Delta value={deltas?.minutes ?? null} />
              </div>
            </>
          ) : (
            <Skeleton className="h-28 w-3/4" />
          )}
          <div className="mt-5">{months.length > 2 && <Sparkline values={months.map((m) => m.minutes)} width={320} height={46} />}</div>
        </div>

        {hero ? (
          <a href={routes.artist(hero.artist)} className="group flex items-center gap-5 rounded-[var(--radius-card)] border border-border bg-surface-1/70 p-4 transition-colors hover:bg-surface-2 animate-rise [animation-delay:80ms]">
            <Cover src={hero.cover} name={hero.label} size={112} round />
            <div className="min-w-0">
              <div className="text-xs text-text-faint">Il tuo artista</div>
              <div className="display truncate text-4xl group-hover:text-[var(--accent)]">{hero.label}</div>
              <div className="num mt-1 text-sm text-text-muted">
                {fmtHours(hero.minutes)} · {fmtInt(hero.plays)} ascolti
              </div>
              <div className="text-xs text-text-faint">con te dal {fmtDate(hero.first_day)}</div>
            </div>
          </a>
        ) : (
          <Skeleton className="h-36" />
        )}
      </section>

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-6 border-y border-border py-6 md:grid-cols-5 animate-rise">
        {k ? (
          <>
            <Stat label="Ascolti (≥30 s)" value={fmtInt(k.plays)} sub={`${fmtInt(k.plays / Math.max(1, k.active_days))} nei giorni attivi`} delta={<Delta value={deltas?.plays ?? null} suffix="" />} />
            <Stat label="Brani diversi" value={fmtInt(k.tracks)} sub={`${fmtPct(k.discovery_rate)} ascolti erano prime volte`} delta={<Delta value={deltas?.tracks ?? null} suffix="" />} />
            <Stat label="Artisti" value={fmtInt(k.artists)} sub={`${fmtInt(k.albums)} album`} delta={<Delta value={deltas?.artists ?? null} suffix="" />} />
            <Stat label="Giorni con musica" value={fmtPct(k.active_days / Math.max(1, days))} sub={`${fmtInt(k.active_days)} su ${fmtInt(days)}`} />
            <Stat label="Salti" value={fmtPct(k.skip_rate)} sub={`shuffle nel ${fmtPct(k.shuffle_rate)} dei casi`} />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)
        )}
      </section>

      {coverPct < 0.5 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface-1/60 px-4 py-3 text-sm text-text-muted">
          <ImageOff size={16} />
          Sto recuperando le copertine in background ({fmtPct(coverPct)} pronte).
          <button className="text-[var(--accent)]" onClick={() => useApp.getState().set({ activityOpen: true })}>
            Vedi attività
          </button>
        </div>
      )}

      {/* Insights + timeline */}
      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        <Section
          kicker="Andamento"
          title={peakMonth ? <>Il tuo mese più intenso: {fmtMonth(peakMonth.ym)}, {fmtHours(peakMonth.minutes)}</> : 'Ore di ascolto per mese'}
        >
          <Card className="p-4 md:p-5">{months.length > 1 ? <PlotChart make={chart} height={200} ariaLabel="Ore di ascolto per mese" /> : <Skeleton className="h-48" />}</Card>
        </Section>
        <Section kicker="Da notare" title="Cose che emergono dai tuoi dati">
          <div className="flex flex-col gap-2">
            {insights.value?.length
              ? insights.value.map((i, n) => (
                  <a key={n} href={i.href} className="group flex items-start gap-3 rounded-xl border border-border bg-surface-1/60 p-3 text-sm transition-colors hover:bg-surface-2">
                    <Sparkles size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                    <span className="flex-1 text-text-muted group-hover:text-text">{i.text}</span>
                  </a>
                ))
              : insights.loading
                ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14" />)
                : <div className="text-sm text-text-faint">Servono più dati in questo periodo.</div>}
          </div>
        </Section>
      </div>

      {/* Eras */}
      {eras.value && eras.value.length > 1 && (
        <Section kicker="Le tue ere" title="Il tuo gusto è cambiato così" action={<a href={routes.insights()} className="text-sm text-[var(--accent)]">Dettagli</a>}>
          <div className="flex gap-1 overflow-hidden rounded-2xl">
            {eras.value.map((e) => (
              <div
                key={e.from}
                className="min-w-0 border-l-2 border-[var(--accent)]/60 bg-surface-1 px-3 py-3 first:border-l-0"
                style={{ flex: `${e.months} 1 0` }}
                title={`${e.name}: ${e.topArtists.join(', ')}`}
              >
                <div className="truncate text-sm font-medium">{e.name}</div>
                <div className="truncate text-xs text-text-faint">
                  {fmtMonth(e.from)} → {fmtMonth(e.to)}
                </div>
                <div className="mt-1 truncate text-xs text-text-muted">{e.topArtists.join(' · ')}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Top lists */}
      <div className="grid gap-10 lg:grid-cols-2">
        <Section kicker="Top artisti" title="Chi ti ha accompagnato" action={<a className="flex items-center gap-1 text-sm text-[var(--accent)]" href={routes.explore('artists')}>Tutti <ArrowRight size={14} /></a>}>
          {topArtists.data ? <EntityList kind="artists" rows={topArtists.data} compact /> : <Skeleton className="h-64" />}
        </Section>
        <Section kicker="Top brani" title="I brani che non ti stancano" action={<a className="flex items-center gap-1 text-sm text-[var(--accent)]" href={routes.explore('tracks')}>Tutti <ArrowRight size={14} /></a>}>
          {topTracks.data ? <EntityList kind="tracks" rows={topTracks.data} compact /> : <Skeleton className="h-64" />}
        </Section>
      </div>

      <Section kicker="Top album" title="Gli album più consumati" action={<a className="flex items-center gap-1 text-sm text-[var(--accent)]" href={routes.explore('albums')}>Tutti <ArrowRight size={14} /></a>}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {(topAlbums.data ?? []).map((a) => (
            <a key={a.label + a.artist} href={routes.album(a.artist, a.label)} className="group min-w-0">
              <Cover src={a.cover} name={a.label} size="fill" className="rounded-xl transition-transform group-hover:-translate-y-0.5" />
              <div className="mt-2 truncate text-sm font-medium group-hover:text-[var(--accent)]">{a.label}</div>
              <div className="truncate text-xs text-text-faint">{a.artist} · {fmtHours(a.minutes)}</div>
            </a>
          ))}
        </div>
      </Section>

      <Card className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
        <div>
          <Badge tone="accent">Racconto</Badge>
          <div className="display mt-2 text-3xl">Rivivi il tuo anno, capitolo per capitolo</div>
          <div className="text-sm text-text-muted">Una storia scorrevole con i tuoi numeri, pronta da condividere.</div>
        </div>
        <a href={routes.story()}>
          <Button variant="primary">
            <BookOpen size={16} /> Apri il racconto
          </Button>
        </a>
      </Card>
    </div>
  );
}

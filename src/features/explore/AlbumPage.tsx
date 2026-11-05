import { useSql, useSqlOne } from '../../data/useSql';
import type { TopRow } from '../../data/queries';
import { useAccentFrom } from '../../lib/color';
import { fmtDate, fmtHours, fmtInt, fmtPct } from '../../lib/format';
import { routes } from '../../lib/router';
import { Cover } from '../../components/Cover';
import { EntityList } from '../../components/EntityList';
import { Badge, Card, Empty, Section, Skeleton, Stat } from '../../components/ui';
import { MonthlyBars } from '../../components/charts/common';
import { StoryButton } from '../../components/StoryButton';
import { periodLabel } from '../../lib/storyCard';
import { useApp } from '../../lib/store';

export default function AlbumPage({ artist, album }: { artist: string; album: string }) {
  const s = useSqlOne<{ minutes: number; plays: number; tracks: number; first_day: string; last_day: string; skip_rate: number; cover: string | null }>(
    `SELECT sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays, count(DISTINCT uri) AS tracks, min(day)::VARCHAR AS first_day,
            max(day)::VARCHAR AS last_day, avg(skipped::INT) AS skip_rate, any_value(cover) FILTER (WHERE cover <> '') AS cover
     FROM p WHERE artist = ? AND album = ?`,
    [artist, album],
  );
  const tracks = useSql<TopRow>(
    `SELECT any_value(track) AS label, uri, any_value(artist) AS artist, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays,
            avg(skipped::INT) AS skip_rate, any_value(cover) AS cover, min(day)::VARCHAR AS first_day
     FROM p WHERE artist = ? AND album = ? GROUP BY uri ORDER BY minutes DESC`,
    [artist, album],
  );
  const monthly = useSql<{ ym: string; minutes: number }>(
    `SELECT strftime(day, '%Y-%m') AS ym, sum(minutes) AS minutes FROM p WHERE artist = ? AND album = ? GROUP BY 1 ORDER BY 1`,
    [artist, album],
  );
  const a = s.row;
  useAccentFrom(a?.cover);
  const range = useApp((st) => st.range);
  if (s.data && (!a || a.minutes == null)) return <Empty title="Nessun ascolto di questo album nel periodo" />;

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col items-start gap-6 md:flex-row md:items-end">
        {a ? <Cover src={a.cover} name={album} size={200} className="rounded-2xl shadow-2xl" /> : <Skeleton className="size-48" />}
        <div className="min-w-0 animate-rise">
          <Badge>Album</Badge>
          <h1 className="display mt-2 break-words text-5xl md:text-6xl">{album}</h1>
          <a href={routes.artist(artist)} className="mt-2 inline-block text-lg text-text-muted hover:text-[var(--accent)]">
            {artist}
          </a>
          <div className="mt-4">
            <StoryButton
              build={() =>
                a
                  ? {
                      kicker: `Album · ${periodLabel(range)}`,
                      title: album,
                      subtitle: artist,
                      image: a.cover,
                      stats: [
                        { label: 'Tempo', value: fmtHours(a.minutes) },
                        { label: 'Ascolti', value: fmtInt(a.plays) },
                        { label: 'Brani diversi', value: fmtInt(a.tracks) },
                        { label: 'Dal', value: fmtDate(a.first_day) },
                      ],
                      sections: [{ title: 'Tracce più ascoltate', rows: (tracks.data ?? []).map((t) => ({ label: t.label, value: fmtInt(t.plays) + '×' })) }],
                      filename: `${artist} ${album}`,
                    }
                  : null
              }
            />
          </div>
        </div>
      </header>
      {a && (
        <section className="grid grid-cols-2 gap-6 border-y border-border py-6 md:grid-cols-4">
          <Stat label="Tempo" value={fmtHours(a.minutes)} />
          <Stat label="Ascolti" value={fmtInt(a.plays)} sub={`${fmtInt(a.tracks)} brani diversi`} />
          <Stat label="Salti" value={fmtPct(a.skip_rate)} />
          <Stat label="Periodo" value={fmtDate(a.first_day)} sub={`fino al ${fmtDate(a.last_day)}`} />
        </section>
      )}
      <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <Section kicker="Brani" title="Tracce in ordine di ascolto">
          {tracks.data ? <EntityList kind="tracks" rows={tracks.data} compact /> : <Skeleton className="h-72" />}
        </Section>
        <Section kicker="Nel tempo" title="Quando l’hai consumato">
          <Card className="p-4">{monthly.data ? <MonthlyBars rows={monthly.data} height={170} /> : <Skeleton className="h-40" />}</Card>
        </Section>
      </div>
    </div>
  );
}

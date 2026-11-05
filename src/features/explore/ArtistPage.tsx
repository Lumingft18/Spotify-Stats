import { useSql, useSqlOne, useAsync } from '../../data/useSql';
import type { TopRow } from '../../data/queries';
import { useAccentFrom } from '../../lib/color';
import { fmtDate, fmtHours, fmtInt, fmtPct } from '../../lib/format';
import { getMood, moodLabel, MOOD_HEX } from '../../lib/mood';
import { routes } from '../../lib/router';
import { similarArtists } from '../../ml/embeddings';
import { Cover } from '../../components/Cover';
import { EntityList } from '../../components/EntityList';
import { Card, Empty, Section, Skeleton, Stat, Badge } from '../../components/ui';
import { HourDowHeatmap, MonthlyBars } from '../../components/charts/common';
import { StoryButton } from '../../components/StoryButton';
import { periodLabel } from '../../lib/storyCard';
import { useApp } from '../../lib/store';

interface ArtistStats {
  minutes: number;
  plays: number;
  tracks: number;
  first_day: string;
  last_day: string;
  skip_rate: number;
  cover: string | null;
  valence: number | null;
  energy: number | null;
  rank: number;
  share: number;
}

export default function ArtistPage({ name }: { name: string }) {
  const s = useSqlOne<ArtistStats>(
    `WITH a AS (SELECT artist, sum(minutes) AS m FROM p GROUP BY artist),
          r AS (SELECT artist, rank() OVER (ORDER BY m DESC) AS rank, m / sum(m) OVER () AS share FROM a)
     SELECT sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays, count(DISTINCT uri) AS tracks,
            min(day)::VARCHAR AS first_day, max(day)::VARCHAR AS last_day, avg(skipped::INT) AS skip_rate,
            arg_max(cover, minutes) FILTER (WHERE cover <> '') AS cover, avg(valence) AS valence, avg(energy) AS energy,
            any_value(r.rank) AS rank, any_value(r.share) AS share
     FROM p JOIN r USING (artist) WHERE artist = ?`,
    [name],
  );
  const monthly = useSql<{ ym: string; minutes: number }>(
    `SELECT strftime(day, '%Y-%m') AS ym, sum(minutes) AS minutes FROM p WHERE artist = ? GROUP BY 1 ORDER BY 1`,
    [name],
  );
  const tracks = useSql<TopRow>(
    `SELECT any_value(track) AS label, uri, any_value(artist) AS artist, sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays,
            avg(skipped::INT) AS skip_rate, any_value(cover) AS cover, min(day)::VARCHAR AS first_day
     FROM p WHERE artist = ? GROUP BY uri ORDER BY minutes DESC LIMIT 15`,
    [name],
  );
  const albums = useSql<{ album: string; cover: string | null; minutes: number }>(
    `SELECT album, any_value(cover) FILTER (WHERE cover <> '') AS cover, sum(minutes) AS minutes FROM p
     WHERE artist = ? AND album <> '' GROUP BY album ORDER BY minutes DESC LIMIT 12`,
    [name],
  );
  const heat = useSql<{ dow: number; hour: number; value: number }>(
    `SELECT dow, hour, sum(minutes) AS value FROM p WHERE artist = ? GROUP BY ALL`,
    [name],
  );
  const similar = useAsync(() => similarArtists(name, 8), [name]);
  const a = s.row;
  useAccentFrom(a?.cover);
  const range = useApp((st) => st.range);

  if (s.data && (!a || a.minutes == null)) {
    return <Empty title="Nessun ascolto in questo periodo">Prova a cambiare il periodo in alto.</Empty>;
  }
  const mood = a ? getMood(a.valence, a.energy) : 'sconosciuto';

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col items-start gap-6 md:flex-row md:items-end">
        {a ? <Cover src={a.cover} name={name} size={176} round className="shadow-2xl" /> : <Skeleton className="size-44 rounded-full" />}
        <div className="min-w-0 animate-rise">
          <div className="mb-2 flex items-center gap-2">
            <Badge>Artista</Badge>
            {a && <Badge tone="accent">#{fmtInt(a.rank)} nel periodo</Badge>}
          </div>
          <h1 className="display break-words text-6xl md:text-7xl">{name}</h1>
          {a && (
            <p className="mt-2 text-text-muted">
              {fmtPct(a.share, 1)} del tuo ascolto · con te dal {fmtDate(a.first_day)} · ultima volta {fmtDate(a.last_day)}
            </p>
          )}
          <div className="mt-4">
            <StoryButton
              build={() =>
                a
                  ? {
                      kicker: `Artista #${fmtInt(a.rank)} · ${periodLabel(range)}`,
                      title: name,
                      subtitle: `${fmtPct(a.share, 1)} del mio ascolto · con me dal ${fmtDate(a.first_day)}`,
                      image: a.cover,
                      roundImage: true,
                      stats: [
                        { label: 'Tempo', value: fmtHours(a.minutes) },
                        { label: 'Ascolti', value: fmtInt(a.plays) },
                        { label: 'Brani diversi', value: fmtInt(a.tracks) },
                        { label: 'Mood', value: moodLabel(mood) },
                      ],
                      sections: [{ title: 'I suoi brani che ascolto di più', rows: (tracks.data ?? []).slice(0, 5).map((t) => ({ label: t.label, value: fmtHours(t.minutes) })) }],
                      filename: name,
                    }
                  : null
              }
            />
          </div>
        </div>
      </header>

      {a && (
        <section className="grid grid-cols-2 gap-6 border-y border-border py-6 md:grid-cols-5">
          <Stat label="Tempo" value={fmtHours(a.minutes)} />
          <Stat label="Ascolti" value={fmtInt(a.plays)} />
          <Stat label="Brani diversi" value={fmtInt(a.tracks)} />
          <Stat label="Salti" value={fmtPct(a.skip_rate)} />
          <Stat
            label="Mood medio"
            value={<span style={{ color: MOOD_HEX[mood] }}>{moodLabel(mood)}</span>}
            sub={a.valence != null ? `valence ${a.valence.toFixed(2)} · energia ${a.energy?.toFixed(2) ?? '—'}` : 'arricchisci per calcolarlo'}
          />
        </section>
      )}

      <Section kicker="Nel tempo" title="Quanto l’hai ascoltato, mese per mese">
        <Card className="p-4">{monthly.data ? <MonthlyBars rows={monthly.data} /> : <Skeleton className="h-44" />}</Card>
      </Section>

      <div className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
        <Section kicker="Brani" title="I suoi brani che ascolti di più">
          {tracks.data ? <EntityList kind="tracks" rows={tracks.data} compact /> : <Skeleton className="h-80" />}
        </Section>
        <div className="flex flex-col gap-10">
          <Section kicker="Quando" title="I momenti in cui lo ascolti">
            <Card className="p-4">{heat.data ? <HourDowHeatmap rows={heat.data} valueLabel="minuti" /> : <Skeleton className="h-52" />}</Card>
          </Section>
          <Section kicker="Vicini nel tuo gusto" title="Artisti che gli somigliano">
            {similar.value?.length ? (
              <div className="flex flex-wrap gap-2">
                {similar.value.map((x) => (
                  <a key={x.artist} href={routes.artist(x.artist)} className="rounded-full border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2">
                    {x.artist}
                  </a>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-faint">
                Crea la mappa del gusto in <a className="text-[var(--accent)]" href={routes.mood()}>Mood & Galassia</a> per vedere gli artisti simili.
              </p>
            )}
          </Section>
        </div>
      </div>

      {albums.data && albums.data.length > 0 && (
        <Section kicker="Album" title="La sua discografia, nei tuoi ascolti">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 min-[2400px]:grid-cols-10">
            {albums.data.map((al) => (
              <a key={al.album} href={routes.album(name, al.album)} className="group min-w-0">
                <Cover src={al.cover} name={al.album} size="fill" className="rounded-xl" />
                <div className="mt-2 truncate text-sm group-hover:text-[var(--accent)]">{al.album}</div>
                <div className="num text-xs text-text-faint">{fmtHours(al.minutes)}</div>
              </a>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

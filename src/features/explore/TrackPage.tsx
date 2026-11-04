import { useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { useSql, useSqlOne, useAsync } from '../../data/useSql';
import { query } from '../../data/db';
import { useAccentFrom } from '../../lib/color';
import { fmtDate, fmtHours, fmtInt, fmtPct } from '../../lib/format';
import { getMood, moodLabel, MOOD_HEX } from '../../lib/mood';
import { routes } from '../../lib/router';
import { similarTo } from '../../ml/embeddings';
import { spotifyId } from '../../enrichment/providers';
import { Cover } from '../../components/Cover';
import { Badge, Button, Card, Empty, Section, Skeleton, Stat } from '../../components/ui';
import { HourDowHeatmap, MonthlyBars } from '../../components/charts/common';

interface TrackInfo {
  track: string;
  artist: string;
  album: string;
  cover: string | null;
  valence: number | null;
  energy: number | null;
  danceability: number | null;
  tempo: number | null;
  mood_source: string | null;
  mood_conf: number | null;
  lyrics: string | null;
  tags: string | null;
  duration_ms: number | null;
  cluster_label: string | null;
}

export default function TrackPage({ uri }: { uri: string }) {
  const info = useSqlOne<TrackInfo>(
    `SELECT t.track, t.artist, t.album, m.cover, m.valence, m.energy, m.danceability, m.tempo, m.mood_source, m.mood_conf,
            m.lyrics, m.tags, t.duration_ms, c.label AS cluster_label
     FROM tracks t LEFT JOIN meta m USING (uri) LEFT JOIN clusters c ON c.id = m.cluster WHERE t.uri = ?`,
    [uri],
  );
  const stats = useSqlOne<{ minutes: number; plays: number; starts: number; first_day: string; last_day: string; skip_rate: number; completion: number; best_day: string; best_n: number }>(
    `WITH d AS (SELECT day, count(*) FILTER (WHERE counted) AS n FROM p WHERE uri = ? GROUP BY day)
     SELECT sum(minutes) AS minutes, count(*) FILTER (WHERE counted) AS plays, count(*) AS starts, min(day)::VARCHAR AS first_day,
            max(day)::VARCHAR AS last_day, avg(skipped::INT) AS skip_rate,
            avg(least(1.0, ms_played / nullif((SELECT duration_ms FROM tracks WHERE uri = ?), 0))) AS completion,
            (SELECT day::VARCHAR FROM d ORDER BY n DESC LIMIT 1) AS best_day, (SELECT max(n) FROM d) AS best_n
     FROM p WHERE uri = ?`,
    [uri, uri, uri],
  );
  const monthly = useSql<{ ym: string; minutes: number }>(
    `SELECT strftime(day, '%Y-%m') AS ym, sum(minutes) AS minutes FROM p WHERE uri = ? GROUP BY 1 ORDER BY 1`,
    [uri],
  );
  const heat = useSql<{ dow: number; hour: number; value: number }>(
    `SELECT dow, hour, count(*)::DOUBLE AS value FROM p WHERE uri = ? GROUP BY ALL`,
    [uri],
  );
  const similar = useAsync(async () => {
    const hits = await similarTo(uri, 10);
    if (!hits.length) return [];
    const rows = await query<{ uri: string; track: string; artist: string; cover: string | null }>(
      `SELECT t.uri, t.track, t.artist, m.cover FROM tracks t LEFT JOIN meta m USING (uri) WHERE t.uri IN (${hits.map(() => '?').join(',')})`,
      hits.map((h) => h.uri),
    );
    const m = new Map(rows.map((r) => [r.uri, r]));
    return hits.map((h) => ({ ...m.get(h.uri)!, score: h.score })).filter((x) => x.track);
  }, [uri]);
  const [player, setPlayer] = useState(false);
  const t = info.row;
  const s = stats.row;
  useAccentFrom(t?.cover);
  const id = spotifyId(uri);

  if (info.data && !t) return <Empty title="Brano non trovato" />;
  const mood = t ? getMood(t.valence, t.energy) : 'sconosciuto';

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col items-start gap-6 md:flex-row md:items-end">
        {t ? <Cover src={t.cover} name={t.track} size={200} className="rounded-2xl shadow-2xl" /> : <Skeleton className="size-48" />}
        <div className="min-w-0 flex-1 animate-rise">
          <div className="mb-2 flex flex-wrap gap-2">
            <Badge>Brano</Badge>
            {t?.cluster_label && <Badge tone="accent">{t.cluster_label}</Badge>}
          </div>
          <h1 className="display break-words text-5xl md:text-6xl">{t?.track ?? ' '}</h1>
          {t && (
            <p className="mt-2 text-lg text-text-muted">
              <a className="hover:text-[var(--accent)]" href={routes.artist(t.artist)}>
                {t.artist}
              </a>
              {t.album && (
                <>
                  {' · '}
                  <a className="hover:text-[var(--accent)]" href={routes.album(t.artist, t.album)}>
                    {t.album}
                  </a>
                </>
              )}
            </p>
          )}
          {id && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => setPlayer((p) => !p)}>
                <Play size={14} /> {player ? 'Nascondi player' : 'Ascolta un’anteprima'}
              </Button>
              <a href={`https://open.spotify.com/track/${id}`} target="_blank" rel="noreferrer">
                <Button size="sm">
                  <ExternalLink size={14} /> Apri in Spotify
                </Button>
              </a>
            </div>
          )}
        </div>
      </header>

      {player && id && (
        <iframe
          title="Player Spotify"
          src={`https://open.spotify.com/embed/track/${id}?utm_source=ascolti&theme=0`}
          width="100%"
          height="152"
          className="rounded-xl border-0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
        />
      )}

      {s && s.minutes != null ? (
        <section className="grid grid-cols-2 gap-6 border-y border-border py-6 md:grid-cols-5">
          <Stat label="Ascolti" value={fmtInt(s.plays)} sub={`${fmtInt(s.starts)} avvii`} />
          <Stat label="Tempo" value={fmtHours(s.minutes)} />
          <Stat label="Lo ascolti fino a" value={fmtPct(s.completion)} sub="della durata, in media" />
          <Stat label="Salti" value={fmtPct(s.skip_rate)} />
          <Stat label="Record in un giorno" value={fmtInt(s.best_n)} sub={fmtDate(s.best_day)} />
        </section>
      ) : (
        stats.data && <Empty title="Nessun ascolto nel periodo selezionato" />
      )}

      <div className="grid gap-10 lg:grid-cols-2">
        <Section kicker="Nel tempo" title={s ? `Dal ${fmtDate(s.first_day)} al ${fmtDate(s.last_day)}` : 'Nel tempo'}>
          <Card className="p-4">{monthly.data ? <MonthlyBars rows={monthly.data} height={170} /> : <Skeleton className="h-40" />}</Card>
        </Section>
        <Section kicker="Quando" title="Ora e giorno degli ascolti">
          <Card className="p-4">{heat.data ? <HourDowHeatmap rows={heat.data} valueLabel="ascolti" height={200} /> : <Skeleton className="h-40" />}</Card>
        </Section>
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
        <Section kicker="Carattere" title={t?.valence != null ? <>Suona <span style={{ color: MOOD_HEX[mood] }}>{moodLabel(mood).toLowerCase()}</span></> : 'Carattere del brano'}>
          <Card className="flex flex-col gap-4">
            {t?.valence != null ? (
              <>
                {[
                  ['Positività', t.valence],
                  ['Energia', t.energy],
                  ['Ballabilità', t.danceability],
                ].map(([l, v]) =>
                  v == null ? null : (
                    <div key={l as string}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span className="text-text-muted">{l}</span>
                        <span className="num">{(v as number).toFixed(2)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-3">
                        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${(v as number) * 100}%` }} />
                      </div>
                    </div>
                  ),
                )}
                {t.tempo ? <div className="num text-sm text-text-muted">{Math.round(t.tempo)} BPM</div> : null}
                <div className="text-xs text-text-faint">
                  Fonte: {t.mood_source === 'reccobeats' ? 'audio features misurate (ReccoBeats)' : `stima AI da testo e tag · confidenza ${fmtPct(t.mood_conf ?? 0)}`}
                </div>
              </>
            ) : (
              <p className="text-sm text-text-faint">Nessun dato sul mood: attiva le audio features o la stima AI in Impostazioni.</p>
            )}
            {t?.tags && (
              <div className="flex flex-wrap gap-1.5">
                {t.tags.split(',').map((g) => (
                  <Badge key={g}>{g.trim()}</Badge>
                ))}
              </div>
            )}
          </Card>
        </Section>
        <Section kicker="Simili" title="Brani che gli somigliano, nel tuo storico">
          {similar.value?.length ? (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {similar.value.map((x) => (
                <a key={x.uri} href={routes.track(x.uri)} className="flex items-center gap-3 rounded-xl p-2 hover:bg-surface-2">
                  <Cover src={x.cover} name={x.track} size={40} />
                  <div className="min-w-0">
                    <div className="truncate text-sm">{x.track}</div>
                    <div className="truncate text-xs text-text-faint">{x.artist}</div>
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-faint">
              Disponibile dopo aver creato la mappa del gusto in <a className="text-[var(--accent)]" href={routes.mood()}>Mood & Galassia</a>.
            </p>
          )}
        </Section>
      </div>

      {t?.lyrics && t.lyrics !== '[strumentale]' && (
        <Section kicker="Testo" title="Le prime righe">
          <Card>
            <p className="display whitespace-pre-line text-2xl leading-snug text-text-muted">{t.lyrics.split('\n').filter(Boolean).slice(0, 8).join('\n')}</p>
            <div className="mt-3 text-xs text-text-faint">Testo da LRCLIB.</div>
          </Card>
        </Section>
      )}
    </div>
  );
}

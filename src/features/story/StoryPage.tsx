import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, Wand2, X } from 'lucide-react';
import { query } from '../../data/db';
import { useAsync } from '../../data/useSql';
import { useRoute, navigate, routes } from '../../lib/router';
import { useApp } from '../../lib/store';
import { extractAccent } from '../../lib/color';
import { DOW_LONG, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { MOOD_HEX, MOOD_SQL, moodLabel, type Mood } from '../../lib/mood';
import { storyCaptions } from '../../llm/narrate';
import { llmAvailable } from '../../llm/client';
import { Button, Spinner } from '../../components/ui';
import { Cover } from '../../components/Cover';

interface StoryData {
  year: number;
  minutes: number;
  days: number;
  activeDays: number;
  topMonth: { ym: string; minutes: number } | null;
  topDay: { day: string; minutes: number } | null;
  artist: { artist: string; minutes: number; cover: string | null; share: number } | null;
  artists5: Array<{ artist: string; minutes: number; cover: string | null }>;
  tracks5: Array<{ uri: string; track: string; artist: string; plays: number; cover: string | null }>;
  mood: { mood: Mood; share: number } | null;
  peak: { dow: number; hour: number } | null;
  skip: number;
  newArtists: number;
  newTop: { artist: string; minutes: number } | null;
  uniqueTracks: number;
}

async function loadStory(year: number): Promise<StoryData | null> {
  const w = `kind = 'track' AND year(day) = ${Math.floor(year)}`;
  const k = await query<{ minutes: number; active: number; skip: number; uniq: number }>(
    `SELECT sum(minutes) AS minutes, count(DISTINCT day) AS active, avg(skipped::INT) AS skip, count(DISTINCT uri) FILTER (WHERE counted) AS uniq FROM plays WHERE ${w}`,
  );
  if (!k[0]?.minutes) return null;
  const topMonth = await query<{ ym: string; minutes: number }>(`SELECT strftime(day,'%Y-%m') AS ym, sum(minutes) AS minutes FROM plays WHERE ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  const topDay = await query<{ day: string; minutes: number }>(`SELECT day::VARCHAR AS day, sum(minutes) AS minutes FROM plays WHERE ${w} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  const artists5 = await query<{ artist: string; minutes: number; cover: string | null }>(`
    SELECT p.artist, sum(p.minutes) AS minutes, arg_max(m.cover, p.minutes) FILTER (WHERE m.cover <> '') AS cover
    FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w.replace(/kind/g, 'p.kind').replace('year(day)', 'year(p.day)')} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
  const tracks5 = await query<{ uri: string; track: string; artist: string; plays: number; cover: string | null }>(`
    SELECT p.uri, any_value(p.track) AS track, any_value(p.artist) AS artist, count(*) FILTER (WHERE p.counted) AS plays, any_value(m.cover) AS cover
    FROM plays p LEFT JOIN meta m USING (uri) WHERE ${w.replace(/kind/g, 'p.kind').replace('year(day)', 'year(p.day)')} GROUP BY 1 ORDER BY plays DESC LIMIT 5`);
  const mood = await query<{ mood: Mood; minutes: number; total: number }>(`
    WITH x AS (SELECT ${MOOD_SQL('m.valence', 'm.energy')} mood, sum(p.minutes) AS minutes FROM plays p LEFT JOIN meta m USING (uri)
               WHERE ${w.replace(/kind/g, 'p.kind').replace('year(day)', 'year(p.day)')} GROUP BY 1)
    SELECT mood, minutes, (SELECT sum(minutes) FROM x WHERE mood <> 'sconosciuto') AS total FROM x WHERE mood <> 'sconosciuto' ORDER BY minutes DESC LIMIT 1`);
  const peak = await query<{ dow: number; hour: number }>(`SELECT dow, hour FROM plays WHERE ${w} GROUP BY ALL ORDER BY sum(minutes) DESC LIMIT 1`);
  const newA = await query<{ n: number }>(`
    WITH f AS (SELECT artist, min(day) AS first_d FROM plays WHERE kind='track' AND counted GROUP BY artist)
    SELECT count(*) AS n FROM f WHERE year(first_d) = ${Math.floor(year)}`);
  const newTop = await query<{ artist: string; minutes: number }>(`
    WITH f AS (SELECT artist, min(day) AS first_d FROM plays WHERE kind='track' AND counted GROUP BY artist)
    SELECT p.artist, sum(p.minutes) AS minutes FROM plays p JOIN f USING (artist)
    WHERE year(f.first_d) = ${Math.floor(year)} AND ${w.replace(/kind/g, 'p.kind').replace('year(day)', 'year(p.day)')} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const total = k[0].minutes;
  return {
    year,
    minutes: total,
    days: isLeap(year) ? 366 : 365,
    activeDays: k[0].active,
    topMonth: topMonth[0] ?? null,
    topDay: topDay[0] ?? null,
    artist: artists5[0] ? { ...artists5[0], share: artists5[0].minutes / total } : null,
    artists5,
    tracks5,
    mood: mood[0] && mood[0].total ? { mood: mood[0].mood, share: mood[0].minutes / mood[0].total } : null,
    peak: peak[0] ?? null,
    skip: k[0].skip,
    newArtists: newA[0]?.n ?? 0,
    newTop: newTop[0] ?? null,
    uniqueTracks: k[0].uniq,
  };
}

function defaultCaptions(d: StoryData): Record<string, string> {
  return {
    intro: `${fmtInt(d.minutes / 60)} ore. Come ${fmtInt(d.minutes / 60 / 24)} giorni interi di sola musica.`,
    time: d.topMonth ? `${fmtMonth(d.topMonth.ym)} è stato il tuo mese più intenso.` : '',
    artist: d.artist ? `${d.artist.artist} si è preso il ${fmtPct(d.artist.share)} del tuo tempo.` : '',
    track: d.tracks5[0] ? `“${d.tracks5[0].track}” è il brano che hai fatto ripartire più volte.` : '',
    mood: d.mood ? `Il tuo anno ha suonato soprattutto ${moodLabel(d.mood.mood).toLowerCase()}.` : 'Arricchisci il mood per scoprire che suono ha avuto il tuo anno.',
    habits: d.peak ? `Il tuo momento: ${DOW_LONG[d.peak.dow - 1]} verso le ${d.peak.hour}.` : '',
    outro: `${fmtInt(d.uniqueTracks)} brani diversi, ${fmtInt(d.newArtists)} artisti scoperti. Alla prossima.`,
  };
}

async function shareCard(d: StoryData) {
  const W = 1080;
  const H = 1920;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const accent = (d.artist?.cover && (await extractAccent(d.artist.cover))) || '#8fd16a';
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#20232c');
  g.addColorStop(1, '#0f1116');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.arc(W * 0.85, 260, 420, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  await document.fonts.ready;
  ctx.fillStyle = '#9aa0ab';
  ctx.font = '500 40px "Geist Variable", system-ui';
  ctx.fillText(`IL MIO ${d.year} IN MUSICA`, 90, 180);
  ctx.fillStyle = '#f4f5f8';
  ctx.font = '400 230px "Instrument Serif", Georgia, serif';
  ctx.fillText(`${fmtInt(d.minutes / 60)}`, 80, 420);
  ctx.font = '400 90px "Instrument Serif", Georgia, serif';
  ctx.fillStyle = accent;
  ctx.fillText('ore di ascolto', 90, 530);
  const loadImg = (src: string) =>
    new Promise<HTMLImageElement | null>((res) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = src;
    });
  let y = 680;
  ctx.fillStyle = '#9aa0ab';
  ctx.font = '500 36px "Geist Variable", system-ui';
  ctx.fillText('ARTISTI', 90, y);
  y += 40;
  for (const [i, a] of d.artists5.entries()) {
    const img = a.cover ? await loadImg(a.cover) : null;
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(90 + 55, y + 55, 55, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 90, y, 110, 110);
      ctx.restore();
    }
    ctx.fillStyle = '#f4f5f8';
    ctx.font = '500 52px "Geist Variable", system-ui';
    ctx.fillText(`${i + 1}. ${a.artist}`.slice(0, 26), 230, y + 72);
    y += 140;
  }
  y += 40;
  ctx.fillStyle = '#9aa0ab';
  ctx.font = '500 36px "Geist Variable", system-ui';
  ctx.fillText('BRANI', 90, y);
  y += 70;
  for (const [i, t] of d.tracks5.entries()) {
    ctx.fillStyle = '#f4f5f8';
    ctx.font = '500 46px "Geist Variable", system-ui';
    ctx.fillText(`${i + 1}. ${t.track}`.slice(0, 32), 90, y);
    ctx.fillStyle = '#9aa0ab';
    ctx.font = '400 34px "Geist Variable", system-ui';
    ctx.fillText(t.artist.slice(0, 40), 140, y + 44);
    y += 110;
  }
  ctx.fillStyle = '#5b6170';
  ctx.font = '400 30px "Geist Mono Variable", monospace';
  ctx.fillText('ascolti · calcolato in locale', 90, H - 90);
  const url = c.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `ascolti-${d.year}.png`;
  a.click();
}

function Chapter({ children, accentFrom, kicker }: { children: React.ReactNode; accentFrom?: string | null; kicker: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !accentFrom) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) void extractAccent(accentFrom).then((c) => c && document.documentElement.style.setProperty('--accent', c));
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [accentFrom]);
  return (
    <section ref={ref} className="relative flex min-h-[100svh] flex-col justify-center px-6 py-20 md:px-16">
      <div className="mx-auto w-full max-w-4xl animate-rise">
        <div className="mb-6 text-xs font-medium uppercase tracking-[0.2em] text-text-faint">{kicker}</div>
        {children}
      </div>
    </section>
  );
}

export default function StoryPage() {
  const { query: qs } = useRoute();
  const bounds = useApp((s) => s.bounds);
  const lastYear = bounds ? Number(bounds.max.slice(0, 4)) : new Date().getFullYear();
  const firstYear = bounds ? Number(bounds.min.slice(0, 4)) : lastYear;
  const year = Number(qs.get('year')) || lastYear;
  const story = useAsync(() => loadStory(year), [year]);
  const [captions, setCaptions] = useState<Record<string, string> | null>(null);
  const [writing, setWriting] = useState(false);
  const d = story.value;
  const cap = captions ?? (d ? defaultCaptions(d) : {});

  useEffect(() => {
    setCaptions(null);
    return () => {
      document.documentElement.style.removeProperty('--accent');
    };
  }, [year]);

  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => lastYear - i);

  return (
    <div className="story-snap h-[100svh] overflow-y-auto" style={{ background: 'radial-gradient(1200px 700px at 80% 0%, color-mix(in oklch, var(--accent) 22%, transparent), transparent 70%), var(--color-bg)' }}>
      <div className="fixed left-0 right-0 top-0 z-20 flex items-center justify-between gap-2 px-4 py-3 lg:left-60">
        <div className="flex gap-1 overflow-x-auto">
          {years.map((y) => (
            <button key={y} onClick={() => navigate(routes.story(y))} className={`h-8 rounded-full px-3 text-sm ${y === year ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2'}`}>
              {y}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {d && llmAvailable() && (
            <Button
              size="sm"
              disabled={writing}
              onClick={async () => {
                setWriting(true);
                try {
                  setCaptions(
                    await storyCaptions({
                      anno: d.year,
                      ore: Math.round(d.minutes / 60),
                      giorni_attivi: d.activeDays,
                      mese_top: d.topMonth ? fmtMonth(d.topMonth.ym) : '',
                      artista_top: d.artist?.artist ?? '',
                      quota_artista_top: fmtPct(d.artist?.share ?? 0),
                      top_artisti: d.artists5.map((a) => a.artist).join(', '),
                      brano_top: d.tracks5[0] ? `${d.tracks5[0].track} di ${d.tracks5[0].artist}` : '',
                      ascolti_brano_top: d.tracks5[0]?.plays ?? 0,
                      mood_prevalente: d.mood ? moodLabel(d.mood.mood) : 'sconosciuto',
                      momento_preferito: d.peak ? `${DOW_LONG[d.peak.dow - 1]} ore ${d.peak.hour}` : '',
                      percentuale_salti: fmtPct(d.skip),
                      artisti_nuovi: d.newArtists,
                      scoperta_top: d.newTop?.artist ?? '',
                      brani_diversi: d.uniqueTracks,
                    }),
                  );
                } catch (e) {
                  console.error(e);
                } finally {
                  setWriting(false);
                }
              }}
            >
              {writing ? <Spinner size={14} /> : <Wand2 size={14} />} Scrivi con AI
            </Button>
          )}
          {d && (
            <Button size="sm" onClick={() => void shareCard(d)}>
              <Download size={14} /> Immagine
            </Button>
          )}
          <a href={routes.overview()} aria-label="Chiudi racconto" className="grid size-8 place-items-center rounded-full text-text-muted hover:bg-surface-2">
            <X size={16} />
          </a>
        </div>
      </div>

      {story.loading && (
        <div className="flex h-full items-center justify-center gap-3 text-text-muted">
          <Spinner /> Preparo il racconto del {year}…
        </div>
      )}
      {!story.loading && !d && <div className="flex h-full items-center justify-center text-text-muted">Nessun ascolto nel {year}.</div>}

      {d && (
        <>
          <Chapter kicker={`Il tuo ${d.year}`} accentFrom={d.artist?.cover}>
            <div className="display text-[clamp(5rem,18vw,13rem)] leading-[0.85]">
              <span className="num font-sans font-medium tracking-tighter">{fmtInt(d.minutes / 60)}</span>
              <span className="text-[0.35em]"> ore</span>
            </div>
            <p className="mt-8 max-w-xl text-2xl text-text-muted">{cap.intro}</p>
            <ChevronDown className="mt-16 animate-bounce text-text-faint" />
          </Chapter>

          <Chapter kicker="Il ritmo">
            <div className="grid gap-10 md:grid-cols-3">
              <div>
                <div className="num text-6xl">{fmtInt(d.activeDays)}</div>
                <div className="text-text-muted">giorni con musica su {d.days}</div>
              </div>
              {d.topMonth && (
                <div>
                  <div className="display text-6xl capitalize">{fmtMonth(d.topMonth.ym).split(' ')[0]}</div>
                  <div className="text-text-muted">il mese più intenso · {fmtHours(d.topMonth.minutes)}</div>
                </div>
              )}
              {d.topDay && (
                <div>
                  <div className="num text-6xl">{fmtHours(d.topDay.minutes)}</div>
                  <div className="text-text-muted">nel giorno record</div>
                </div>
              )}
            </div>
            <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.time}</p>
          </Chapter>

          {d.artist && (
            <Chapter kicker="Il tuo artista" accentFrom={d.artist.cover}>
              <div className="flex flex-col items-start gap-8 md:flex-row md:items-center">
                <Cover src={d.artist.cover} name={d.artist.artist} size={260} round className="shadow-2xl" />
                <div>
                  <div className="display text-[clamp(3.5rem,9vw,7rem)] leading-none">{d.artist.artist}</div>
                  <div className="num mt-3 text-xl text-[var(--accent)]">{fmtHours(d.artist.minutes)}</div>
                </div>
              </div>
              <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.artist}</p>
              <ol className="mt-8 flex flex-wrap gap-3 text-text-muted">
                {d.artists5.slice(1).map((a, i) => (
                  <li key={a.artist} className="rounded-full border border-border px-3 py-1">
                    <span className="num text-text-faint">{i + 2}</span> {a.artist}
                  </li>
                ))}
              </ol>
            </Chapter>
          )}

          {d.tracks5.length > 0 && (
            <Chapter kicker="I tuoi brani" accentFrom={d.tracks5[0].cover}>
              <ol className="flex flex-col gap-4">
                {d.tracks5.map((t, i) => (
                  <li key={t.uri} className="flex items-center gap-5">
                    <span className="num w-8 text-2xl text-text-faint">{i + 1}</span>
                    <Cover src={t.cover} name={t.track} size={i === 0 ? 96 : 64} />
                    <div className="min-w-0">
                      <div className={`${i === 0 ? 'display text-5xl' : 'text-2xl'} truncate`}>{t.track}</div>
                      <div className="truncate text-text-muted">
                        {t.artist} · <span className="num">{fmtInt(t.plays)}</span> ascolti
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.track}</p>
            </Chapter>
          )}

          <Chapter kicker="Il suono del tuo anno">
            {d.mood ? (
              <div className="display text-[clamp(4rem,12vw,9rem)] leading-none" style={{ color: MOOD_HEX[d.mood.mood] }}>
                {moodLabel(d.mood.mood)}
              </div>
            ) : (
              <div className="display text-6xl text-text-faint">Mood sconosciuto</div>
            )}
            {d.mood && <div className="num mt-3 text-xl text-text-muted">{fmtPct(d.mood.share)} del tempo con mood noto</div>}
            <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.mood}</p>
          </Chapter>

          <Chapter kicker="Abitudini">
            <div className="grid gap-10 md:grid-cols-3">
              {d.peak && (
                <div>
                  <div className="display text-6xl capitalize">{DOW_LONG[d.peak.dow - 1]}</div>
                  <div className="text-text-muted">alle {d.peak.hour}:00, il tuo momento</div>
                </div>
              )}
              <div>
                <div className="num text-6xl">{fmtPct(d.skip)}</div>
                <div className="text-text-muted">dei brani saltati</div>
              </div>
              <div>
                <div className="num text-6xl">{fmtInt(d.newArtists)}</div>
                <div className="text-text-muted">artisti scoperti{d.newTop ? `, il primo: ${d.newTop.artist}` : ''}</div>
              </div>
            </div>
            <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.habits}</p>
          </Chapter>

          <Chapter kicker="Fine">
            <div className="display text-[clamp(3rem,8vw,6rem)] leading-none">{cap.outro}</div>
            <div className="mt-10 flex flex-wrap gap-3">
              <Button variant="primary" onClick={() => void shareCard(d)}>
                <Download size={16} /> Scarica l’immagine da condividere
              </Button>
              <a href={routes.overview()}>
                <Button>Vai alla panoramica</Button>
              </a>
            </div>
          </Chapter>
        </>
      )}
    </div>
  );
}

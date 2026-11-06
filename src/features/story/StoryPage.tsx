import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, Wand2, X } from 'lucide-react';
import { loadFacts, yearWhere, type Facts, type MoodDay } from '../../data/facts';
import { useAsync } from '../../data/useSql';
import { useRoute, navigate, routes } from '../../lib/router';
import { useApp } from '../../lib/store';
import { extractAccent } from '../../lib/color';
import { DOW_LONG, fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct } from '../../lib/format';
import { getMood, MOOD_HEX, moodLabel } from '../../lib/mood';
import { storyCaptions } from '../../llm/narrate';
import { useLlmAvailable } from '../../llm/client';
import { Button, Spinner } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { profileFirstName } from '../../data/account';
import { StoryButton } from '../../components/StoryButton';
import { exportStory, type StoryCardSpec } from '../../lib/storyCard';

type StoryData = Facts;

function defaultCaptions(d: StoryData): Record<string, string> {
  return {
    intro: `${fmtInt(d.minutes / 60)} ore. Come ${fmtInt(d.minutes / 60 / 24)} giorni interi di sola musica.`,
    time: d.topMonth ? `${fmtMonth(d.topMonth.ym)} è stato il tuo mese più intenso.` : '',
    artist: d.artist ? `${d.artist.artist} si è preso il ${fmtPct(d.artist.share)} del tuo tempo.` : '',
    track: d.tracks5[0] ? `“${d.tracks5[0].track}” è il brano che hai fatto ripartire più volte.` : '',
    mood: d.mood ? `Il tuo anno ha suonato soprattutto ${moodLabel(d.mood.mood).toLowerCase()}.` : 'Arricchisci il mood per scoprire che suono ha avuto il tuo anno.',
    habits: d.peak
      ? `Il tuo momento: ${DOW_LONG[d.peak.dow - 1]} verso le ${d.peak.hour}.${d.night && d.night.share >= 0.05 ? ` E il ${fmtPct(d.night.share)} lo ascolti dopo mezzanotte.` : ''}`
      : '',
    days:
      d.happyDay && d.sadDay
        ? `Il ${fmtDate(d.happyDay.day)} sorridevi con ${d.happyDay.tracks[0]?.artist ?? 'la tua musica'}; il ${fmtDate(d.sadDay.day)} cercavi conforto in ${d.sadDay.tracks[0]?.artist ?? 'altro'}.`
        : 'Arricchisci il mood per scoprire i tuoi giorni più felici e più tristi.',
    records: d.streak
      ? `${fmtInt(d.streak.days)} giorni di fila senza mai spegnere la musica${d.obsession ? `, e un giorno “${d.obsession.track}” l’hai messa ${fmtInt(d.obsession.n)} volte` : ''}.`
      : '',
    outro: `${fmtInt(d.uniqueTracks)} brani diversi, ${fmtInt(d.newArtists)} artisti ${d.year ? "scoperti" : "in tutto"}. Alla prossima.`,
  };
}

type StoryKey = 'summary' | 'intro' | 'time' | 'years' | 'artist' | 'track' | 'mood' | 'days' | 'records' | 'habits';

function storySpec(d: StoryData, key: StoryKey, cap: Record<string, string>): StoryCardSpec {
  const kicker = d.year ? `Il mio ${d.year} in musica` : 'Tutta la mia musica';
  const filename = `${d.year || 'tutti-gli-anni'}-${key}`;
  const hours = { value: fmtInt(d.minutes / 60), unit: 'ore di ascolto' };
  switch (key) {
    case 'intro':
      return {
        kicker,
        hero: hours,
        stats: [
          { label: 'Giorni con musica', value: `${fmtInt(d.activeDays)} / ${fmtInt(d.days)}` },
          { label: 'Brani diversi', value: fmtInt(d.uniqueTracks) },
        ],
        note: cap.intro,
        accentFrom: d.artist?.cover,
        filename,
      };
    case 'time':
      return {
        kicker: `${kicker} · il ritmo`,
        title: d.topMonth ? fmtMonth(d.topMonth.ym) : 'Il ritmo',
        subtitle: d.topMonth ? `il mio mese più intenso · ${fmtHours(d.topMonth.minutes)}` : undefined,
        stats: d.topDay ? [{ label: 'Giorno record', value: fmtHours(d.topDay.minutes) }] : undefined,
        note: cap.time,
        accentFrom: d.artist?.cover,
        filename,
      };
    case 'years':
      return {
        kicker: 'Anno per anno',
        title: `${d.byYear.length} anni di musica`,
        bars: { title: 'Ore per anno', values: d.byYear.map((y) => y.minutes), from: String(d.byYear[0]?.year ?? ''), to: String(d.byYear[d.byYear.length - 1]?.year ?? '') },
        sections: [{ title: 'Artista dell’anno', rows: [...d.byYear].reverse().map((y) => ({ label: String(y.year), sub: y.artist, value: fmtHours(y.minutes), image: y.cover, round: true })) }],
        accentFrom: d.byYear[d.byYear.length - 1]?.cover,
        filename,
      };
    case 'artist':
      return {
        kicker: `${kicker} · il mio artista`,
        title: d.artist?.artist ?? '',
        image: d.artist?.cover ?? null,
        roundImage: true,
        hero: d.artist ? { value: fmtPct(d.artist.share), unit: 'del mio tempo' } : undefined,
        note: cap.artist,
        filename,
      };
    case 'track':
      return {
        kicker: `${kicker} · i miei brani`,
        title: d.tracks5[0]?.track,
        subtitle: d.tracks5[0] ? `${d.tracks5[0].artist} · ${fmtInt(d.tracks5[0].plays)} ascolti` : undefined,
        image: d.tracks5[0]?.cover ?? null,
        sections: [{ title: 'Top 5', rows: d.tracks5.map((t) => ({ label: t.track, sub: t.artist, value: `${fmtInt(t.plays)}×` })) }],
        filename,
      };
    case 'mood':
      return {
        kicker: `${kicker} · il suono`,
        title: d.mood ? moodLabel(d.mood.mood) : 'Il suono del mio anno',
        hero: d.mood ? { value: fmtPct(d.mood.share), unit: 'del mio ascolto' } : undefined,
        accent: d.mood ? MOOD_HEX[d.mood.mood] : undefined,
        note: cap.mood,
        filename,
      };
    case 'days':
      return {
        kicker: `${kicker} · giorni`,
        title: 'Il giorno più felice',
        subtitle: d.happyDay ? fmtDate(d.happyDay.day) : undefined,
        image: d.happyDay?.tracks[0]?.cover ?? null,
        accent: MOOD_HEX.euforico,
        sections: [
          ...(d.happyDay ? [{ title: `Felice · ${fmtDate(d.happyDay.day)}`, rows: d.happyDay.tracks.slice(0, 3).map((t) => ({ label: t.track, sub: t.artist, image: t.cover })) }] : []),
          ...(d.sadDay ? [{ title: `Triste · ${fmtDate(d.sadDay.day)}`, rows: d.sadDay.tracks.slice(0, 3).map((t) => ({ label: t.track, sub: t.artist, image: t.cover })) }] : []),
        ],
        note: cap.days,
        filename,
      };
    case 'records':
      return {
        kicker: `${kicker} · record`,
        title: 'I miei record',
        hero: d.streak ? { value: fmtInt(d.streak.days), unit: 'giorni di fila con musica' } : undefined,
        stats: [
          ...(d.marathon ? [{ label: 'Maratona', value: fmtHours(d.marathon.minutes) }] : []),
          ...(d.obsession ? [{ label: 'Ossessione', value: `${fmtInt(d.obsession.n)}× ${d.obsession.track}` }] : []),
          ...(d.comeback ? [{ label: 'Ritorno', value: d.comeback.track }] : []),
        ],
        note: cap.records,
        accentFrom: d.obsession?.cover ?? d.artist?.cover,
        filename,
      };
    case 'habits':
      return {
        kicker: `${kicker} · abitudini`,
        title: d.peak ? `${DOW_LONG[d.peak.dow - 1]} alle ${d.peak.hour}` : 'Abitudini',
        subtitle: 'il mio momento musicale',
        stats: [
          { label: 'Brani saltati', value: fmtPct(d.skip) },
          { label: d.year ? 'Artisti scoperti' : 'Artisti', value: fmtInt(d.newArtists) },
          ...(d.newTop ? [{ label: 'Scoperta top', value: d.newTop.artist }] : []),
        ],
        note: cap.habits,
        accentFrom: d.artist?.cover,
        filename,
      };
    default:
      return {
        kicker,
        hero: hours,
        sections: [
          { title: 'Artisti', rows: d.artists5.map((a) => ({ label: a.artist, value: fmtHours(a.minutes), image: a.cover, round: true })) },
          { title: 'Brani', rows: d.tracks5.map((t) => ({ label: t.track, sub: t.artist })) },
        ],
        accentFrom: d.artist?.cover,
        filename: `${d.year || 'tutti-gli-anni'}`,
      };
  }
}

const shareCard = (d: StoryData) => exportStory(storySpec(d, 'summary', {}));

function Chapter({ children, accentFrom, kicker, story }: { children: React.ReactNode; accentFrom?: string | null; kicker: string; story?: () => StoryCardSpec }) {
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
    <section ref={ref} data-chapter={kicker} className="relative flex min-h-[100svh] flex-col justify-center px-6 py-24 md:px-16">
      <div className="story-reveal mx-auto w-full max-w-5xl 2xl:max-w-7xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-text-faint">{kicker}</div>
          {story && <StoryButton variant="ghost" build={story} />}
        </div>
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
  const year = qs.get('year') === 'all' ? 0 : Number(qs.get('year')) || lastYear;
  const story = useAsync(() => loadFacts(yearWhere(year), year), [year]);
  const ai = useLlmAvailable();
  const firstName = profileFirstName(useApp((s) => s.profile));
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

  // Chapter tracking: reveal-on-view, active dot, keyboard navigation (↑/↓, PagSu/PagGiù, spazio, Home/Fine).
  const scroller = useRef<HTMLDivElement>(null);
  const [chapters, setChapters] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const root = scroller.current;
    if (!root || !d) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>('section[data-chapter]'));
    setChapters(sections.map((s) => s.dataset.chapter ?? ''));
    // Reveal when a chapter enters the viewport.
    const reveal = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('is-visible')),
      { root, threshold: 0.15 },
    );
    // Active chapter = the one crossing the vertical centre of the screen (works for tall chapters too).
    const centre = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(sections.indexOf(e.target as HTMLElement));
      },
      { root, rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    );
    const io = { disconnect: () => (reveal.disconnect(), centre.disconnect()) };
    sections.forEach((s) => {
      reveal.observe(s);
      centre.observe(s);
    });
    return () => io.disconnect();
  }, [d]);

  // Back to the top and focus (for keyboard nav) only when the year changes — not on background data refreshes.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    root.scrollTo({ top: 0, behavior: 'auto' });
    root.focus({ preventScroll: true });
  }, [year]);

  const goTo = (i: number) => {
    const root = scroller.current;
    const sections = root?.querySelectorAll<HTMLElement>('section[data-chapter]');
    if (!sections?.length) return;
    const idx = Math.max(0, Math.min(sections.length - 1, i));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root!.scrollTo({ top: sections[idx].offsetTop, behavior: reduce ? 'auto' : 'smooth' });
  };

  const currentIndex = () => {
    const root = scroller.current;
    if (!root) return 0;
    const mid = root.scrollTop + root.clientHeight / 2;
    const sections = Array.from(root.querySelectorAll<HTMLElement>('section[data-chapter]'));
    const i = sections.findIndex((s) => s.offsetTop <= mid && s.offsetTop + s.offsetHeight > mid);
    return i < 0 ? 0 : i;
  };

  const onKey = (e: React.KeyboardEvent) => {
    const root = scroller.current;
    if (!root || (e.target as HTMLElement).closest('button, a, input')) return;
    const i = currentIndex();
    const sec = root.querySelectorAll<HTMLElement>('section[data-chapter]')[i];
    // Long chapters: let the arrow keys scroll natively until the chapter's end is on screen.
    const rest = sec ? sec.offsetTop + sec.offsetHeight - (root.scrollTop + root.clientHeight) : 0;
    if (['ArrowDown', 'PageDown', ' ', 'j'].includes(e.key) && !e.shiftKey) {
      if (rest > 8 && (e.key === 'ArrowDown' || e.key === 'j')) return;
      e.preventDefault();
      goTo(i + 1);
    } else if (['ArrowUp', 'PageUp', 'k'].includes(e.key) || (e.key === ' ' && e.shiftKey)) {
      e.preventDefault();
      goTo(root.scrollTop > (sec?.offsetTop ?? 0) + 8 ? i : i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      goTo(chapters.length - 1);
    }
  };

  return (
    <div
      ref={scroller}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label="Racconto: usa le frecce o la rotella per scorrere i capitoli"
      className="story-snap h-[100svh] overflow-y-auto outline-none"
      style={{ background: 'radial-gradient(1200px 700px at 80% 0%, color-mix(in oklch, var(--accent) 22%, transparent), transparent 70%), var(--color-bg)' }}>
      {chapters.length > 1 && (
        <>
          <nav aria-label="Capitoli" className="fixed right-3 top-1/2 z-20 hidden -translate-y-1/2 flex-col gap-2.5 md:flex">
            {chapters.map((c, i) => (
              <button
                key={c}
                onClick={() => goTo(i)}
                aria-label={`Vai a: ${c}`}
                aria-current={i === active ? 'step' : undefined}
                title={c}
                className={`group flex items-center justify-end gap-2`}
              >
                <span className="pointer-events-none whitespace-nowrap rounded-full bg-surface-2/90 px-2 py-0.5 text-[11px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">{c}</span>
                <span className={`block rounded-full transition-all ${i === active ? 'h-6 w-1.5 bg-[var(--accent)]' : 'size-1.5 bg-text-faint/60 group-hover:bg-text'}`} />
              </button>
            ))}
          </nav>
          <div className="fixed bottom-0 left-0 right-0 z-20 h-0.5 bg-surface-2 lg:left-60" aria-hidden>
            <div className="h-full bg-[var(--accent)] transition-[width] duration-500" style={{ width: `${((active + 1) / chapters.length) * 100}%` }} />
          </div>
        </>
      )}
      <div className="fixed left-0 right-0 top-0 z-20 flex items-center justify-between gap-2 bg-gradient-to-b from-bg/90 to-transparent px-4 py-3 backdrop-blur-[2px] lg:left-60">
        <div className="flex gap-1 overflow-x-auto">
          <button onClick={() => navigate(routes.story('all'))} className={`h-8 rounded-full px-3 text-sm ${year === 0 ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2'}`}>
            Tutti gli anni
          </button>
          {years.map((y) => (
            <button key={y} onClick={() => navigate(routes.story(y))} className={`h-8 rounded-full px-3 text-sm ${y === year ? 'bg-surface-3 text-text' : 'text-text-muted hover:bg-surface-2'}`}>
              {y}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {d && ai && (
            <Button
              size="sm"
              disabled={writing}
              onClick={async () => {
                setWriting(true);
                try {
                  setCaptions(
                    await storyCaptions({
                      anno: d.label,
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
                      giorno_piu_felice: d.happyDay ? `${fmtDate(d.happyDay.day)}: ${d.happyDay.tracks.map((t) => `${t.track} di ${t.artist}`).join(', ')}` : '',
                      giorno_piu_triste: d.sadDay ? `${fmtDate(d.sadDay.day)}: ${d.sadDay.tracks.map((t) => `${t.track} di ${t.artist}`).join(', ')}` : '',
                      giorno_piu_carico: d.wildDay ? `${fmtDate(d.wildDay.day)}: ${d.wildDay.tracks.map((t) => t.artist).join(', ')}` : '',
                      brano_piu_allegro: d.happyTrack ? `${d.happyTrack.track} di ${d.happyTrack.artist}` : '',
                      brano_piu_triste: d.sadTrack ? `${d.sadTrack.track} di ${d.sadTrack.artist}` : '',
                      mix_mood: d.moodMix.map((m) => `${moodLabel(m.mood)} ${fmtPct(m.share)}`).join(', '),
                      serie_giorni_consecutivi: d.streak?.days ?? 0,
                      maratona_ore: d.marathon ? Math.round(d.marathon.minutes / 6) / 10 : 0,
                      ossessione: d.obsession ? `${d.obsession.track} di ${d.obsession.artist}, ${d.obsession.n} volte il ${fmtDate(d.obsession.day)}` : '',
                      ritorno_di_fiamma: d.comeback ? `${d.comeback.track} di ${d.comeback.artist} dopo ${d.comeback.gap} giorni` : '',
                      quota_notturna: d.night ? fmtPct(d.night.share) : '',
                      brano_notturno: d.night?.track ? `${d.night.track} di ${d.night.artist}` : '',
                      quota_weekend: fmtPct(d.weekendShare),
                      primo_brano: d.firstTrack ? `${d.firstTrack.track} di ${d.firstTrack.artist}` : '',
                      ultimo_brano: d.lastTrack ? `${d.lastTrack.track} di ${d.lastTrack.artist}` : '',
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
              <Download size={14} /> Storia IG
            </Button>
          )}
          <a href={routes.overview()} aria-label="Chiudi racconto" className="grid size-8 place-items-center rounded-full text-text-muted hover:bg-surface-2">
            <X size={16} />
          </a>
        </div>
      </div>

      {story.loading && !d && (
        <div className="flex h-full items-center justify-center gap-3 text-text-muted">
          <Spinner /> Preparo il racconto {year ? `del ${year}` : 'di tutti gli anni'}…
        </div>
      )}
      {!story.loading && !d && <div className="flex h-full items-center justify-center text-text-muted">Nessun ascolto {year ? `nel ${year}` : ''}.</div>}

      {d && (
        <>
          <Chapter kicker={d.year ? (firstName ? `Il ${d.year} di ${firstName}` : `Il tuo ${d.year}`) : firstName ? `Tutti gli anni di ${firstName}` : 'Tutti i tuoi anni'} accentFrom={d.artist?.cover} story={() => storySpec(d, 'intro', cap)}>
            <div className="display text-[clamp(5rem,18vw,13rem)] leading-[0.85]">
              <span className="num font-sans font-medium tracking-tighter">{fmtInt(d.minutes / 60)}</span>
              <span className="text-[0.35em]"> ore</span>
            </div>
            <p className="mt-8 max-w-xl text-2xl text-text-muted">{cap.intro}</p>
            <button onClick={() => goTo(1)} aria-label="Capitolo successivo" className="mt-16 flex items-center gap-2 text-sm text-text-faint hover:text-text">
              <ChevronDown className="animate-bounce" /> scorri o usa ↓
            </button>
          </Chapter>

          <Chapter kicker="Il ritmo" story={() => storySpec(d, 'time', cap)}>
            <div className="grid gap-10 md:grid-cols-3">
              <div>
                <div className="num text-6xl">{fmtInt(d.activeDays)}</div>
                <div className="text-text-muted">giorni con musica su {fmtInt(d.days)}</div>
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

          {d.byYear.length > 1 && (
            <Chapter kicker="Anno per anno" accentFrom={d.byYear[d.byYear.length - 1].cover} story={() => storySpec(d, 'years', cap)}>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {d.byYear.map((y) => {
                  const max = Math.max(...d.byYear.map((x) => x.minutes));
                  return (
                    <button
                      key={y.year}
                      onClick={() => navigate(routes.story(y.year))}
                      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface-1/70 p-4 text-left transition-colors hover:bg-surface-2"
                    >
                      <Cover src={y.cover} name={y.artist} size={72} round />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="display text-4xl group-hover:text-[var(--accent)]">{y.year}</span>
                          <span className="num text-sm text-text-muted">{fmtHours(y.minutes)}</span>
                        </div>
                        <div className="truncate font-medium">{y.artist}</div>
                        <div className="truncate text-xs text-text-faint">{y.track}</div>
                        <div className="mt-2 h-1 rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${(y.minutes / max) * 100}%` }} />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="mt-8 max-w-xl text-2xl text-text-muted">Clicca un anno per aprire il suo racconto.</p>
            </Chapter>
          )}

          {d.artist && (
            <Chapter kicker="Il tuo artista" accentFrom={d.artist.cover} story={() => storySpec(d, 'artist', cap)}>
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
            <Chapter kicker="I tuoi brani" accentFrom={d.tracks5[0].cover} story={() => storySpec(d, 'track', cap)}>
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

          <Chapter kicker="Il suono del tuo anno" story={() => storySpec(d, 'mood', cap)}>
            {d.mood ? (
              <div className="display text-[clamp(4rem,12vw,9rem)] leading-none" style={{ color: MOOD_HEX[d.mood.mood] }}>
                {moodLabel(d.mood.mood)}
              </div>
            ) : (
              <div className="display text-6xl text-text-faint">Mood sconosciuto</div>
            )}
            {d.mood && <div className="num mt-3 text-xl text-text-muted">{fmtPct(d.mood.share)} del tempo con mood noto</div>}
            {d.moodMix.length > 1 && <MoodMix mix={d.moodMix} />}
            <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.mood}</p>
            {(d.happyTrack || d.sadTrack) && (
              <div className="mt-8 flex flex-wrap gap-6 text-text-muted">
                {d.happyTrack && <TrackChip label="Il più solare tra i tuoi preferiti" t={d.happyTrack} color={MOOD_HEX.euforico} />}
                {d.sadTrack && <TrackChip label="Il più cupo" t={d.sadTrack} color={MOOD_HEX.malinconico} />}
              </div>
            )}
          </Chapter>

          {(d.happyDay || d.sadDay) && (
            <Chapter kicker="Giorni felici, giorni tristi" accentFrom={d.happyDay?.tracks[0]?.cover} story={() => storySpec(d, 'days', cap)}>
              <div className="grid gap-6 md:grid-cols-2">
                {d.happyDay && <DayCard title="Il giorno più felice" day={d.happyDay} color={MOOD_HEX.euforico} />}
                {d.sadDay && <DayCard title="Il giorno più triste" day={d.sadDay} color={MOOD_HEX.malinconico} />}
                {d.wildDay && <DayCard title="Il giorno più carico" day={d.wildDay} color={MOOD_HEX.arrabbiato} compact />}
                {d.calmDay && <DayCard title="Il giorno più calmo" day={d.calmDay} color={MOOD_HEX.sereno} compact />}
              </div>
              <p className="mt-10 max-w-2xl text-2xl text-text-muted">{cap.days}</p>
              <p className="mt-2 text-xs text-text-faint">Media pesata sul tempo della positività (valence) e dell’energia dei brani; solo giorni con almeno 45 minuti di mood noto.</p>
            </Chapter>
          )}

          {(d.streak || d.marathon || d.obsession) && (
            <Chapter kicker="Record" accentFrom={d.obsession?.cover} story={() => storySpec(d, 'records', cap)}>
              <div className="grid gap-x-10 gap-y-12 md:grid-cols-2">
                {d.streak && (
                  <Fact value={fmtInt(d.streak.days)} unit="giorni di fila" sub={`dal ${fmtDate(d.streak.from)} al ${fmtDate(d.streak.to)}, mai un giorno senza musica`} />
                )}
                {d.marathon && (
                  <Fact value={fmtHours(d.marathon.minutes)} unit="di maratona" sub={`${fmtInt(d.marathon.tracks)} brani senza pause, iniziata il ${fmtDate(d.marathon.start)} alle ${d.marathon.start.slice(11, 16)}`} />
                )}
                {d.obsession && (
                  <Fact value={`${fmtInt(d.obsession.n)}×`} unit={`“${d.obsession.track}”`} sub={`${d.obsession.artist}, tutte il ${fmtDate(d.obsession.day)}`} cover={d.obsession.cover} />
                )}
                {d.comeback && (
                  <Fact value={fmtInt(d.comeback.gap)} unit="giorni dopo" sub={`“${d.comeback.track}” di ${d.comeback.artist} è tornato nei tuoi ascolti il ${fmtDate(d.comeback.day)}`} cover={d.comeback.cover} />
                )}
              </div>
              <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.records}</p>
            </Chapter>
          )}

          <Chapter kicker="Abitudini" story={() => storySpec(d, 'habits', cap)}>
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
                <div className="text-text-muted">{d.year ? 'artisti scoperti' : 'artisti ascoltati'}{d.newTop ? `, il primo: ${d.newTop.artist}` : ''}</div>
              </div>
              {d.night && (
                <div>
                  <div className="num text-6xl">{fmtPct(d.night.share)}</div>
                  <div className="text-text-muted">dopo mezzanotte{d.night.track ? `, soprattutto “${d.night.track}”` : ''}</div>
                </div>
              )}
              <div>
                <div className="num text-6xl">{fmtPct(d.weekendShare)}</div>
                <div className="text-text-muted">nel weekend</div>
              </div>
              <div>
                <div className="num text-6xl">{fmtPct(d.shuffle)}</div>
                <div className="text-text-muted">in riproduzione casuale</div>
              </div>
            </div>
            <p className="mt-10 max-w-xl text-2xl text-text-muted">{cap.habits}</p>
          </Chapter>

          <Chapter kicker="Fine">
            <div className="display text-[clamp(3rem,8vw,6rem)] leading-none">{cap.outro}</div>
            {d.firstTrack && d.lastTrack && (
              <p className="mt-6 max-w-2xl text-xl text-text-muted">
                Hai iniziato con “{d.firstTrack.track}” di {d.firstTrack.artist} ({fmtDate(d.firstTrack.day)}) e chiuso con “{d.lastTrack.track}” di {d.lastTrack.artist} (
                {fmtDate(d.lastTrack.day)}).
              </p>
            )}
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

function MoodMix({ mix }: { mix: Facts['moodMix'] }) {
  return (
    <div className="mt-8 max-w-3xl">
      <div className="flex h-3 overflow-hidden rounded-full">
        {mix.map((m) => (
          <div key={m.mood} style={{ width: `${m.share * 100}%`, background: MOOD_HEX[m.mood] }} title={`${moodLabel(m.mood)} ${fmtPct(m.share)}`} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-muted">
        {mix.map((m) => (
          <span key={m.mood} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: MOOD_HEX[m.mood] }} />
            {moodLabel(m.mood)} <span className="num text-text-faint">{fmtPct(m.share)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function TrackChip({ label, t, color }: { label: string; t: { track: string; artist: string; cover: string | null }; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <Cover src={t.cover} name={t.track} size={48} />
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-[0.12em]" style={{ color }}>{label}</div>
        <div className="truncate text-text">{t.track}</div>
        <div className="truncate text-sm">{t.artist}</div>
      </div>
    </div>
  );
}

function DayCard({ title, day, color, compact = false }: { title: string; day: MoodDay; color: string; compact?: boolean }) {
  const mood = getMood(day.valence, day.energy);
  return (
    <div className="rounded-2xl border border-border bg-surface-1/70 p-5" style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
      <div className="text-xs font-medium uppercase tracking-[0.14em]" style={{ color }}>{title}</div>
      <div className={`display mt-1 ${compact ? 'text-3xl' : 'text-5xl'}`}>{fmtDate(day.day)}</div>
      <div className="num mt-1 text-sm text-text-muted">
        {fmtHours(day.minutes)} · positività {Math.round(day.valence * 100)}/100{day.energy != null ? ` · energia ${Math.round(day.energy * 100)}/100` : ''} · {moodLabel(mood).toLowerCase()}
      </div>
      {!compact && (
        <ol className="mt-4 flex flex-col gap-2">
          {day.tracks.slice(0, 4).map((t) => (
            <li key={t.track + t.artist} className="flex items-center gap-3">
              <Cover src={t.cover} name={t.track} size={36} />
              <div className="min-w-0">
                <div className="truncate">{t.track}</div>
                <div className="truncate text-xs text-text-faint">
                  {t.artist} · {fmtInt(t.n)}×
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {compact && day.tracks[0] && <div className="mt-2 truncate text-sm text-text-muted">soprattutto {day.tracks.slice(0, 3).map((t) => t.artist).filter((a, i, all) => all.indexOf(a) === i).join(', ')}</div>}
    </div>
  );
}

function Fact({ value, unit, sub, cover }: { value: string; unit: string; sub: string; cover?: string | null }) {
  return (
    <div className="flex items-start gap-4">
      {cover !== undefined && <Cover src={cover} name={unit} size={64} className="mt-2" />}
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="num text-6xl">{value}</span>
          <span className="display text-2xl">{unit}</span>
        </div>
        <div className="mt-1 text-text-muted">{sub}</div>
      </div>
    </div>
  );
}

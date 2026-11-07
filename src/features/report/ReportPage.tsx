// One-click PDF: a purpose-built A4 document (not screenshots of the app). Light paper, vector SVG charts,
// small covers, every number from the same facts as the Racconto. Printed by the browser → "Salva come PDF".
import { coverSrc } from '../../lib/api';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, FileDown, Printer } from 'lucide-react';
import { query, getExcluded } from '../../data/db';
import { useAsync } from '../../data/useSql';
import { loadFacts, rangeWhere, type Facts, type MoodDay } from '../../data/facts';
import { HOUR_DOW_SQL, KPI_SQL, MONTHLY_SQL, topSql, type Kpi, type TopRow } from '../../data/queries';
import { useApp } from '../../lib/store';
import { periodLabel } from '../../lib/storyCard';
import { countryName, DOW, DOW_LONG, fmtDate, fmtHours, fmtInt, fmtMonth, fmtPct, monthShort } from '../../lib/format';
import { getMood, MOOD_HEX, MOOD_SQL, moodLabel, type Mood } from '../../lib/mood';
import { nameGradient } from '../../lib/color';
import { Button, Spinner } from '../../components/ui';
import { runAllEnabled, stopAll } from '../../enrichment/jobs';
import { holdEnrichment } from '../../enrichment/pause';
import { ArtistsPage, CalendarPage, ErasPage, MapPage, MoodOverTime, SessionKinds, SkipPage } from './ReportExtra';
import { loadExtra, reasonLabel, type ExtraData } from './reportExtraData';

// SVG colours come from the app's theme tokens (same dark look as on screen).
const ACCENT = { fill: 'var(--accent-doc)' } as const;
const FAINT = { fill: 'var(--faint)' } as const;

interface ReportData {
  f: Facts;
  k: Kpi;
  monthly: Array<{ ym: string; minutes: number }>;
  heat: Array<{ dow: number; hour: number; avg_minutes: number }>;
  artists: TopRow[];
  tracks: TopRow[];
  albums: TopRow[];
  platforms: Array<{ label: string; minutes: number }>;
  countries: Array<{ label: string; minutes: number; days: number }>;
  endings: Array<{ label: string; n: number }>;
  discovery: Array<{ year: number; n: number }>;
  moodYears: Array<{ year: number; mood: Mood; minutes: number }>;
  excluded: number;
  x: ExtraData;
}

async function loadReport(from: string | null, to: string | null): Promise<ReportData | null> {
  const f = await loadFacts(rangeWhere(from, to), 0);
  if (!f) return null;
  const [k] = await query<Kpi>(KPI_SQL);
  const [monthly, heat, artists, tracks, albums, platforms, countries, endings, discovery, moodYears, excluded, x] = await Promise.all([
    query<{ ym: string; minutes: number }>(MONTHLY_SQL),
    query<{ dow: number; hour: number; avg_minutes: number }>(HOUR_DOW_SQL),
    query<TopRow>(topSql('artists', 'minutes', 20)),
    query<TopRow>(topSql('tracks', 'minutes', 20)),
    query<TopRow>(topSql('albums', 'minutes', 12)),
    query<{ label: string; minutes: number }>(`SELECT platform AS label, sum(minutes) AS minutes FROM p GROUP BY 1 ORDER BY 2 DESC`),
    query<{ label: string; minutes: number; days: number }>(`SELECT country AS label, sum(minutes) AS minutes, count(DISTINCT day) AS days FROM p GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    query<{ label: string; n: number }>(`SELECT coalesce(reason_end, '—') AS label, count(*) AS n FROM p GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    query<{ year: number; n: number }>(`
      WITH f AS (SELECT artist, min(day) AS d FROM plays WHERE kind = 'track' AND counted GROUP BY artist)
      SELECT year(d) AS year, count(*) AS n FROM f WHERE d BETWEEN (SELECT min(day) FROM p) AND (SELECT max(day) FROM p) GROUP BY 1 ORDER BY 1`),
    query<{ year: number; mood: Mood; minutes: number }>(`SELECT year(day) AS year, ${MOOD_SQL('valence', 'energy')} AS mood, sum(minutes) AS minutes FROM p GROUP BY ALL`),
    getExcluded(),
    loadExtra(),
  ]);
  return { f, k, monthly, heat, artists, tracks, albums, platforms, countries, endings, discovery, moodYears, excluded: excluded.length, x };
}

/** Ready = data loaded and every image settled — stable for 1.5 s. */
function useImagesReady(root: React.RefObject<HTMLElement | null>, dataReady: boolean, maxMs = 30_000) {
  const [state, setState] = useState({ ready: false, pending: 0 });
  useEffect(() => {
    if (!dataReady) return;
    const t0 = Date.now();
    let stableSince = 0;
    const id = setInterval(() => {
      const el = root.current;
      if (!el) return;
      const pending = Array.from(el.querySelectorAll('img')).filter((i) => !i.complete).length;
      const now = Date.now();
      if (pending === 0) stableSince ||= now;
      else stableSince = 0;
      const ready = (stableSince > 0 && now - stableSince > 1500) || now - t0 > maxMs;
      setState({ ready, pending });
      if (ready) clearInterval(id);
    }, 300);
    return () => clearInterval(id);
  }, [root, dataReady, maxMs]);
  return state;
}

// ---------- small building blocks ----------

function Thumb({ src, name, size = 22, round = false }: { src?: string | null; name: string; size?: number; round?: boolean }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, borderRadius: round ? '50%' : Math.max(3, size / 7) };
  if (!src || failed) return <span className="doc-thumb" style={{ ...style, background: nameGradient(name) }} aria-hidden />;
  return <img className="doc-thumb" style={style} src={coverSrc(src) ?? undefined} alt="" crossOrigin="anonymous" decoding="async" onError={() => setFailed(true)} />;
}

function Page({ id, kicker, title, children }: { id: string; kicker: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="doc-page" id={`r-${id}`}>
      <header className="doc-head">
        <div className="doc-kicker">{kicker}</div>
        <h2 className="doc-h2">{title}</h2>
      </header>
      {children}
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="doc-h3">{children}</h3>;
}

function Kpis({ items, cols = 3 }: { items: Array<{ label: string; value: string; sub?: string }>; cols?: number }) {
  return (
    <div className="doc-kpis" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {items.map((i) => (
        <div key={i.label} className="doc-kpi">
          <div className="doc-kpi-v">{i.value}</div>
          <div className="doc-kpi-l">{i.label}</div>
          {i.sub && <div className="doc-kpi-s">{i.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function RankTable({ rows, kind, metric = 'minutes' }: { rows: TopRow[]; kind: 'artists' | 'tracks' | 'albums'; metric?: 'minutes' | 'plays' }) {
  const max = Math.max(...rows.map((r) => r.minutes), 1);
  return (
    <table className="doc-rank">
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.label}-${r.artist}-${i}`}>
            <td className="doc-rank-n">{i + 1}</td>
            <td className="doc-rank-c">
              <Thumb src={r.cover} name={r.label} round={kind === 'artists'} />
            </td>
            <td className="doc-rank-t">
              <div className="doc-trunc doc-strong">{r.label}</div>
              <div className="doc-trunc doc-sub">{kind === 'artists' ? `${fmtInt(r.n_tracks ?? 0)} brani` : r.artist}</div>
              <div className="doc-meter">
                <span style={{ width: `${(r.minutes / max) * 100}%` }} />
              </div>
            </td>
            <td className="doc-rank-v">
              <div className="doc-num">{metric === 'plays' ? fmtInt(r.plays) : fmtHours(r.minutes)}</div>
              <div className="doc-sub doc-num">{metric === 'plays' ? fmtHours(r.minutes) : `${fmtInt(r.plays)}×`}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HBars({ rows, fmt }: { rows: Array<{ label: string; value: number; note?: string }>; fmt: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="doc-hbars">
      {rows.map((r) => (
        <div key={r.label} className="doc-hbar">
          <div className="doc-hbar-l doc-trunc">{r.label}</div>
          <div className="doc-hbar-b">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <div className="doc-hbar-v doc-num">
            {fmt(r.value)}
            {r.note && <span className="doc-sub"> · {r.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Vertical bars as SVG (vector in the PDF). */
function BarChart({ values, labels, height = 150, every = 1, highlight }: { values: number[]; labels: string[]; height?: number; every?: number; highlight?: number }) {
  const W = 1000;
  const H = height;
  const pad = { t: 8, b: 22, l: 0, r: 0 };
  const max = Math.max(...values, 1);
  const bw = (W - pad.l - pad.r) / Math.max(values.length, 1);
  return (
    <svg className="doc-svg" viewBox={`0 0 ${W} ${H}`} role="img">
      <line x1={0} x2={W} y1={H - pad.b} y2={H - pad.b} style={{ stroke: 'var(--rule)' }} />
      {values.map((v, i) => {
        const h = ((H - pad.t - pad.b) * v) / max;
        return <rect key={i} x={pad.l + i * bw + bw * 0.12} y={H - pad.b - h} width={bw * 0.76} height={h} rx={Math.min(3, bw * 0.2)} style={{ ...ACCENT, fillOpacity: highlight == null || i === highlight ? 1 : 0.5 }} />;
      })}
      {labels.map((l, i) =>
        l && i % every === 0 ? (
          <text key={i} x={pad.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize={11} style={FAINT}>
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function Heatmap({ cells }: { cells: ReportData['heat'] }) {
  const max = Math.max(...cells.map((c) => c.avg_minutes), 1);
  const at = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.avg_minutes]));
  const cw = 30;
  const ch = 18;
  const lx = 34;
  return (
    <svg className="doc-svg" viewBox={`0 0 ${lx + 24 * cw} ${7 * ch + 20}`} role="img">
      {DOW.map((d, r) => (
        <text key={d} x={0} y={r * ch + ch * 0.7} fontSize={10} style={FAINT}>
          {d}
        </text>
      ))}
      {Array.from({ length: 7 }, (_, r) =>
        Array.from({ length: 24 }, (_, h) => {
          const v = at.get(`${r + 1}-${h}`) ?? 0;
          const t = Math.pow(v / max, 0.8);
          return <rect key={`${r}-${h}`} x={lx + h * cw + 1} y={r * ch + 1} width={cw - 2} height={ch - 2} rx={3} style={{ ...ACCENT, fillOpacity: 0.07 + t * 0.93 }} />;
        }),
      )}
      {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
        <text key={h} x={lx + h * cw + cw / 2} y={7 * ch + 14} fontSize={10} textAnchor="middle" style={FAINT}>
          {h}
        </text>
      ))}
    </svg>
  );
}

function MoodBar({ mix, height = 10 }: { mix: Array<{ mood: Mood; share: number }>; height?: number }) {
  return (
    <div className="doc-moodbar" style={{ height }}>
      {mix.map((m) => (
        <span key={m.mood} style={{ width: `${m.share * 100}%`, background: MOOD_HEX[m.mood] }} />
      ))}
    </div>
  );
}

function DayCard({ title, d, color }: { title: string; d: MoodDay; color: string }) {
  return (
    <div className="doc-card" style={{ borderLeftColor: color }}>
      <div className="doc-kicker" style={{ color }}>
        {title}
      </div>
      <div className="doc-day">{fmtDate(d.day)}</div>
      <div className="doc-sub doc-num">
        {fmtHours(d.minutes)} · positività {Math.round(d.valence * 100)}/100{d.energy != null ? ` · energia ${Math.round(d.energy * 100)}/100` : ''} ·{' '}
        {moodLabel(getMood(d.valence, d.energy)).toLowerCase()}
      </div>
      <ol className="doc-daylist">
        {d.tracks.slice(0, 3).map((t) => (
          <li key={t.track + t.artist}>
            <Thumb src={t.cover} name={t.track} size={20} />
            <span className="doc-trunc">
              <b>{t.track}</b> <span className="doc-sub">· {t.artist}</span>
            </span>
            <span className="doc-sub doc-num">{t.n}×</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- the narrative: every fact, in prose ----------

function narrative(f: Facts, k: Kpi): Array<{ title: string; text: string }> {
  const out: Array<{ title: string; text: string }> = [];
  const days = Math.max(1, f.days);
  out.push({
    title: 'Il tempo',
    text: `In questo periodo hai ascoltato ${fmtInt(f.minutes / 60)} ore di musica: come ${fmtInt(f.minutes / 60 / 24)} giorni interi senza pause. La musica c’è stata in ${fmtInt(f.activeDays)} giorni su ${fmtInt(days)} (${fmtPct(f.activeDays / days)}), in media ${fmtHours(f.minutes / Math.max(1, f.activeDays))} in ogni giorno attivo, per ${fmtInt(k.plays)} ascolti di ${fmtInt(f.uniqueTracks)} brani diversi.`,
  });
  if (f.topMonth || f.topDay)
    out.push({
      title: 'Il ritmo',
      text: [
        f.topMonth && `Il mese più intenso è stato ${fmtMonth(f.topMonth.ym)}, con ${fmtHours(f.topMonth.minutes)}.`,
        f.topDay && `Il giorno record il ${fmtDate(f.topDay.day)}: ${fmtHours(f.topDay.minutes)} in 24 ore.`,
        f.peak && `Il tuo momento tipico è il ${DOW_LONG[f.peak.dow - 1]} verso le ${f.peak.hour}:00;`,
        `il ${fmtPct(f.weekendShare)} dell’ascolto cade nel weekend${f.night && f.night.share >= 0.01 ? ` e il ${fmtPct(f.night.share)} dopo mezzanotte${f.night.track ? `, quando vince “${f.night.track}” di ${f.night.artist}` : ''}` : ''}.`,
      ]
        .filter(Boolean)
        .join(' '),
    });
  if (f.artist)
    out.push({
      title: 'Le persone',
      text: `${f.artist.artist} ti ha accompagnato più di chiunque altro: ${fmtHours(f.artist.minutes)}, il ${fmtPct(f.artist.share)} del tuo tempo. Seguono ${f.artists5
        .slice(1)
        .map((a) => a.artist)
        .join(', ')}. In tutto ${fmtInt(f.artistsCount)} artisti${
        // On the whole history every artist is "new": the split only means something for a sub-period.
        f.newArtists < f.artistsCount ? `, di cui ${fmtInt(f.newArtists)} scoperti per la prima volta${f.newTop ? ` (il più ascoltato tra i nuovi: ${f.newTop.artist})` : ''}` : ''
      }.`,
    });
  if (f.tracks5[0])
    out.push({
      title: 'I brani',
      text: `“${f.tracks5[0].track}” di ${f.tracks5[0].artist} è il brano che hai fatto partire più volte (${fmtInt(f.tracks5[0].plays)}).${f.obsession ? ` Il ${fmtDate(f.obsession.day)} hai messo “${f.obsession.track}” ${fmtInt(f.obsession.n)} volte nello stesso giorno.` : ''}${f.comeback ? ` Ritorno di fiamma: “${f.comeback.track}” di ${f.comeback.artist}, ripreso il ${fmtDate(f.comeback.day)} dopo ${fmtInt(f.comeback.gap)} giorni di silenzio.` : ''}`,
    });
  if (f.mood)
    out.push({
      title: 'Il suono',
      text: `Il periodo ha suonato soprattutto ${moodLabel(f.mood.mood).toLowerCase()} (${fmtPct(f.mood.share)} del tempo con mood noto): ${f.moodMix.map((m) => `${moodLabel(m.mood).toLowerCase()} ${fmtPct(m.share)}`).join(', ')}.${f.happyTrack ? ` Tra i tuoi preferiti il più solare è “${f.happyTrack.track}” di ${f.happyTrack.artist}` : ''}${f.sadTrack ? `, il più cupo “${f.sadTrack.track}” di ${f.sadTrack.artist}.` : f.happyTrack ? '.' : ''} Mood noto per il ${fmtPct(f.moodCoverage)} del tempo.`,
    });
  if (f.happyDay || f.sadDay)
    out.push({
      title: 'Giorni felici, giorni tristi',
      text: [
        f.happyDay && `Il giorno più felice è stato il ${fmtDate(f.happyDay.day)}: ${fmtHours(f.happyDay.minutes)} di ${f.happyDay.tracks.slice(0, 3).map((t) => `“${t.track}”`).join(', ')}.`,
        f.sadDay && `Il più triste il ${fmtDate(f.sadDay.day)}, tra ${f.sadDay.tracks.slice(0, 3).map((t) => `“${t.track}” di ${t.artist}`).join(', ')}.`,
        f.wildDay && `Il più carico il ${fmtDate(f.wildDay.day)}${f.calmDay ? `, il più calmo il ${fmtDate(f.calmDay.day)}` : ''}.`,
      ]
        .filter(Boolean)
        .join(' '),
    });
  if (f.streak || f.marathon)
    out.push({
      title: 'Record',
      text: [
        f.streak && `${fmtInt(f.streak.days)} giorni di fila con musica, dal ${fmtDate(f.streak.from)} al ${fmtDate(f.streak.to)}.`,
        f.marathon && `La sessione più lunga: ${fmtHours(f.marathon.minutes)} senza pause oltre i 30 minuti, ${fmtInt(f.marathon.tracks)} brani, iniziata il ${fmtDate(f.marathon.start)} alle ${f.marathon.start.slice(11, 16)}.`,
        `Hai saltato il ${fmtPct(f.skip)} dei brani e usato la riproduzione casuale nel ${fmtPct(f.shuffle)} dei casi.`,
      ]
        .filter(Boolean)
        .join(' '),
    });
  if (f.firstTrack && f.lastTrack)
    out.push({
      title: 'Inizio e fine',
      text: `Il primo brano del periodo: “${f.firstTrack.track}” di ${f.firstTrack.artist}, il ${fmtDate(f.firstTrack.day)}. L’ultimo: “${f.lastTrack.track}” di ${f.lastTrack.artist}, il ${fmtDate(f.lastTrack.day)}.`,
    });
  return out;
}

// ---------- page ----------

export default function ReportPage() {
  const root = useRef<HTMLDivElement>(null);
  const range = useApp((s) => s.range);
  const profile = useApp((s) => s.profile);
  const data = useAsync(() => loadReport(range.from, range.to), [range.from, range.to]);
  const r = data.value;
  const { ready, pending } = useImagesReady(root, !!r);
  const printed = useRef(false);
  const [done, setDone] = useState(false);
  const name = profile?.displayName ?? profile?.username ?? null;
  const today = new Date().toISOString().slice(0, 10);

  // Freeze background enrichment while the report is open: a consistent snapshot.
  useEffect(() => {
    holdEnrichment(true);
    stopAll();
    return () => {
      holdEnrichment(false);
      runAllEnabled();
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('report-mode');
    const prevTitle = document.title;
    document.title = `Ascolti – ${periodLabel(range)} – ${today}`;
    const after = () => setDone(true);
    window.addEventListener('afterprint', after);
    return () => {
      document.documentElement.classList.remove('report-mode');
      document.title = prevTitle;
      window.removeEventListener('afterprint', after);
    };
  }, [range, today]);

  const autoPrint = !location.hash.includes('noprint=1');
  useEffect(() => {
    if (!ready || printed.current || !autoPrint) return;
    printed.current = true;
    requestAnimationFrame(() => setTimeout(() => window.print(), 300));
  }, [ready, autoPrint]);

  return (
    <div className="report-root">
      <div className="report-toolbar no-print">
        <a href="#/" className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text">
          <ArrowLeft size={16} /> Torna all’app
        </a>
        <div className="flex items-center gap-3 text-sm text-text-muted" aria-live="polite">
          {!ready ? (
            <>
              <Spinner /> Preparo il PDF… {pending > 0 && <span className="num">{fmtInt(pending)} copertine in caricamento</span>}
            </>
          ) : (
            <>
              <FileDown size={16} className="text-[var(--accent)]" />
              {done ? 'Fatto.' : 'Pronto.'} Nella finestra di stampa scegli “Salva come PDF”, formato A4.
            </>
          )}
          <Button size="sm" variant="primary" disabled={!ready} onClick={() => window.print()}>
            <Printer size={14} /> {done ? 'Salva di nuovo' : 'Salva PDF'}
          </Button>
        </div>
      </div>

      {data.loading && !r && (
        <div className="flex items-center justify-center gap-3 py-24 text-text-muted">
          <Spinner /> Calcolo il report…
        </div>
      )}
      {!data.loading && !r && <div className="py-24 text-center text-text-muted">Nessun ascolto nel periodo.</div>}
      {r && (
        <div ref={root} className="doc">
          <Report r={r} name={name} range={range} today={today} />
        </div>
      )}
    </div>
  );
}

function Report({ r, name, range, today }: { r: ReportData; name: string | null; range: { from: string | null; to: string | null }; today: string }) {
  const { f, k } = r;
  const story = narrative(f, k);
  const topMonthIdx = r.monthly.findIndex((m) => m.ym === f.topMonth?.ym);
  const totalPlatform = r.platforms.reduce((s, p) => s + p.minutes, 0) || 1;
  const totalEnd = r.endings.reduce((s, p) => s + p.n, 0) || 1;
  const monthLabels = r.monthly.map((m) => (m.ym.endsWith('-01') ? m.ym.slice(0, 4) : ''));
  const allTime = !range.from && !range.to;
  const x = r.x;
  // Page order; optional pages appear only when their data exists. Numbers and the contents follow this list.
  const TITLES: Record<string, string> = {
    story: 'Il racconto',
    years: 'Anno per anno',
    time: 'Quando ascolti',
    calendar: 'Calendario',
    top: 'Classifiche',
    albums: 'Album e momenti',
    mood: 'Mood',
    map: 'Mappa del gusto',
    eras: 'Le tue ere',
    artists: 'Artisti nel tempo',
    skip: 'Quando salti',
    habits: 'Abitudini',
  };
  const has: Record<string, boolean> = {
    calendar: x.daily.length >= 14,
    map: !!x.map && x.map.points.length >= 30,
    eras: x.eras.length >= 2,
    artists: !!x.survival && x.survival.curve.length >= 3,
    skip: !!x.skip,
  };
  const order = Object.keys(TITLES).filter((id) => has[id] ?? true);
  const kick = (id: string) => `${String(order.indexOf(id) + 2).padStart(2, '0')} · ${TITLES[id]}`;

  return (
    <>
      {/* 1 · Cover */}
      <section className="doc-page doc-cover">
        <div className="doc-kicker">Ascolti · report</div>
        <h1 className="doc-h1">{name ? `La musica di ${name}` : 'La tua musica'}</h1>
        <p className="doc-lead">
          {periodLabel(range)} · {fmtDate(f.firstDay)} — {fmtDate(f.lastDay)}
        </p>
        <Kpis
          items={[
            { label: 'ore di ascolto', value: fmtInt(f.minutes / 60), sub: `${fmtInt(f.minutes / 60 / 24)} giorni interi` },
            { label: 'ascolti', value: fmtInt(k.plays), sub: `${fmtInt(k.sessions)} sessioni` },
            { label: 'brani diversi', value: fmtInt(f.uniqueTracks) },
            { label: 'artisti', value: fmtInt(f.artistsCount), sub: allTime ? undefined : `${fmtInt(f.newArtists)} nuovi` },
            { label: 'giorni con musica', value: fmtInt(f.activeDays), sub: `su ${fmtInt(f.days)}` },
            { label: 'mood prevalente', value: f.mood ? moodLabel(f.mood.mood) : '—', sub: f.mood ? fmtPct(f.mood.share) : undefined },
          ]}
        />
        <div className="doc-podium">
          {f.artist && (
            <div className="doc-pod">
              <Thumb src={f.artist.cover} name={f.artist.artist} size={64} round />
              <div className="min-w-0">
                <div className="doc-kicker">Artista</div>
                <div className="doc-strong doc-trunc">{f.artist.artist}</div>
                <div className="doc-sub doc-num">{fmtHours(f.artist.minutes)} · {fmtPct(f.artist.share)}</div>
              </div>
            </div>
          )}
          {r.tracks[0] && (
            <div className="doc-pod">
              <Thumb src={r.tracks[0].cover} name={r.tracks[0].label} size={64} />
              <div className="min-w-0">
                <div className="doc-kicker">Brano</div>
                <div className="doc-strong doc-trunc">{r.tracks[0].label}</div>
                <div className="doc-sub doc-trunc">{r.tracks[0].artist} · {fmtHours(r.tracks[0].minutes)}</div>
              </div>
            </div>
          )}
          {r.albums[0] && (
            <div className="doc-pod">
              <Thumb src={r.albums[0].cover} name={r.albums[0].label} size={64} />
              <div className="min-w-0">
                <div className="doc-kicker">Album</div>
                <div className="doc-strong doc-trunc">{r.albums[0].label}</div>
                <div className="doc-sub doc-trunc">{r.albums[0].artist} · {fmtHours(r.albums[0].minutes)}</div>
              </div>
            </div>
          )}
        </div>
        <ol className="doc-toc">
          {order.map((id, i) => (
            <li key={id}>
              <span className="doc-num doc-sub">{String(i + 2).padStart(2, '0')}</span> {TITLES[id]}
            </li>
          ))}
        </ol>
        <p className="doc-foot">
          Generato il {fmtDate(today)} · calcolato sul tuo dispositivo, nessun dato inviato.
          {r.excluded > 0 && ` ${fmtInt(r.excluded)} ${r.excluded === 1 ? 'brano escluso' : 'brani esclusi'} da tutte le statistiche.`}
        </p>
      </section>

      {/* 2 · Story */}
      <Page id="story" kicker={kick('story')} title="La tua storia in numeri">
        <div className="doc-story">
          {story.map((p) => (
            <div key={p.title} className="doc-para">
              <h3 className="doc-h3">{p.title}</h3>
              <p>{p.text}</p>
            </div>
          ))}
        </div>
      </Page>

      {/* 3 · Years */}
      <Page id="years" kicker={kick('years')} title={f.byYear.length > 1 ? `${f.byYear.length} anni di musica` : `Il ${f.byYear[0]?.year}`}>
        <BarChart values={f.byYear.map((y) => y.minutes / 60)} labels={f.byYear.map((y) => String(y.year))} height={140} highlight={f.byYear.reduce((b, y, i, a) => (y.minutes > a[b].minutes ? i : b), 0)} />
        <table className="doc-table">
          <thead>
            <tr>
              <th>Anno</th>
              <th className="r">Ore</th>
              <th>Artista dell’anno</th>
              <th>Brano dell’anno</th>
              <th>Mood</th>
            </tr>
          </thead>
          <tbody>
            {f.byYear.map((y) => (
              <tr key={y.year}>
                <td className="doc-num doc-strong">{y.year}</td>
                <td className="r doc-num">{fmtInt(y.minutes / 60)}</td>
                <td>
                  <span className="doc-inline">
                    <Thumb src={y.cover} name={y.artist} size={18} round />
                    <span className="doc-trunc">{y.artist}</span>
                  </span>
                </td>
                <td className="doc-trunc doc-sub" style={{ maxWidth: '62mm' }}>
                  {y.track}
                </td>
                <td>
                  {y.mood ? (
                    <span className="doc-inline">
                      <span className="doc-dot" style={{ background: MOOD_HEX[y.mood] }} />
                      {moodLabel(y.mood)}
                    </span>
                  ) : (
                    <span className="doc-sub">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Page>

      {/* 4 · When */}
      <Page id="time" kicker={kick('time')} title={f.topMonth ? `Il mese più intenso: ${fmtMonth(f.topMonth.ym)}` : 'Il ritmo'}>
        <H3>Ore per mese</H3>
        <BarChart values={r.monthly.map((m) => m.minutes / 60)} labels={r.monthly.length > 24 ? monthLabels : r.monthly.map((m) => monthShort(Number(m.ym.slice(5))))} height={150} highlight={topMonthIdx} />
        <H3>Minuti medi per giorno della settimana e ora</H3>
        <Heatmap cells={r.heat} />
        <Kpis
          items={[
            ...(f.peak ? [{ label: 'il tuo momento', value: `${DOW[f.peak.dow - 1]} ${f.peak.hour}:00` }] : []),
            ...(f.topDay ? [{ label: 'giorno record', value: fmtHours(f.topDay.minutes), sub: fmtDate(f.topDay.day) }] : []),
            ...(f.streak ? [{ label: 'giorni di fila', value: fmtInt(f.streak.days), sub: `${fmtDate(f.streak.from)} — ${fmtDate(f.streak.to)}` }] : []),
            ...(f.marathon ? [{ label: 'maratona', value: fmtHours(f.marathon.minutes), sub: fmtDate(f.marathon.start) }] : []),
            { label: 'nel weekend', value: fmtPct(f.weekendShare) },
            ...(f.night ? [{ label: 'dopo mezzanotte', value: fmtPct(f.night.share) }] : []),
          ]}
        />
      </Page>

      {has.calendar && <CalendarPage x={x} kicker={kick('calendar')} />}

      {/* 5 · Charts */}
      <Page id="top" kicker={kick('top')} title="Chi e cosa hai ascoltato di più">
        <div className="doc-cols">
          <div>
            <H3>Artisti</H3>
            <RankTable rows={r.artists} kind="artists" />
          </div>
          <div>
            <H3>Brani</H3>
            <RankTable rows={r.tracks} kind="tracks" />
          </div>
        </div>
      </Page>

      {/* 6 · Albums & moments */}
      <Page id="albums" kicker={kick('albums')} title="Gli album e i brani che hanno lasciato il segno">
        <div className="doc-cols">
          <div>
            <H3>Album</H3>
            <RankTable rows={r.albums} kind="albums" />
          </div>
          <div className="doc-stack">
            <H3>Momenti</H3>
            {f.obsession && (
              <div className="doc-moment">
                <Thumb src={f.obsession.cover} name={f.obsession.track} size={40} />
                <div className="min-w-0">
                  <div className="doc-kicker">Ossessione</div>
                  <div className="doc-strong doc-trunc">{f.obsession.track}</div>
                  <div className="doc-sub">{fmtInt(f.obsession.n)} volte il {fmtDate(f.obsession.day)}</div>
                </div>
              </div>
            )}
            {f.comeback && (
              <div className="doc-moment">
                <Thumb src={f.comeback.cover} name={f.comeback.track} size={40} />
                <div className="min-w-0">
                  <div className="doc-kicker">Ritorno di fiamma</div>
                  <div className="doc-strong doc-trunc">{f.comeback.track}</div>
                  <div className="doc-sub">{f.comeback.artist} · dopo {fmtInt(f.comeback.gap)} giorni, il {fmtDate(f.comeback.day)}</div>
                </div>
              </div>
            )}
            {f.night?.track && (
              <div className="doc-moment">
                <Thumb src={f.night.cover} name={f.night.track} size={40} />
                <div className="min-w-0">
                  <div className="doc-kicker">Di notte</div>
                  <div className="doc-strong doc-trunc">{f.night.track}</div>
                  <div className="doc-sub">{f.night.artist} · il più ascoltato tra mezzanotte e le 5</div>
                </div>
              </div>
            )}
            {f.firstTrack && (
              <div className="doc-moment">
                <Thumb src={f.firstTrack.cover} name={f.firstTrack.track} size={40} />
                <div className="min-w-0">
                  <div className="doc-kicker">Primo brano</div>
                  <div className="doc-strong doc-trunc">{f.firstTrack.track}</div>
                  <div className="doc-sub">{f.firstTrack.artist} · {fmtDate(f.firstTrack.day)}</div>
                </div>
              </div>
            )}
            {f.lastTrack && (
              <div className="doc-moment">
                <Thumb src={f.lastTrack.cover} name={f.lastTrack.track} size={40} />
                <div className="min-w-0">
                  <div className="doc-kicker">Ultimo brano</div>
                  <div className="doc-strong doc-trunc">{f.lastTrack.track}</div>
                  <div className="doc-sub">{f.lastTrack.artist} · {fmtDate(f.lastTrack.day)}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Page>

      {/* 7 · Mood */}
      <Page id="mood" kicker={kick('mood')} title={f.mood ? `Il tuo suono è soprattutto ${moodLabel(f.mood.mood).toLowerCase()}` : 'Il mood dei tuoi ascolti'}>
        {f.moodMix.length > 0 ? (
          <>
            <MoodBar mix={f.moodMix} height={14} />
            <div className="doc-legend">
              {f.moodMix.map((m) => (
                <span key={m.mood}>
                  <span className="doc-dot" style={{ background: MOOD_HEX[m.mood] }} /> {moodLabel(m.mood)} <b className="doc-num">{fmtPct(m.share)}</b>
                </span>
              ))}
              <span className="doc-sub">mood noto per il {fmtPct(f.moodCoverage)} del tempo</span>
            </div>
            <MoodOverTime x={x} />
            <H3>Giorni felici, giorni tristi</H3>
            <div className="doc-grid2">
              {f.happyDay && <DayCard title="Il giorno più felice" d={f.happyDay} color={MOOD_HEX.euforico} />}
              {f.sadDay && <DayCard title="Il giorno più triste" d={f.sadDay} color={MOOD_HEX.malinconico} />}
              {f.wildDay && <DayCard title="Il giorno più carico" d={f.wildDay} color={MOOD_HEX.arrabbiato} />}
              {f.calmDay && <DayCard title="Il giorno più calmo" d={f.calmDay} color={MOOD_HEX.sereno} />}
            </div>
            {(f.happyTrack || f.sadTrack) && (
              <div className="doc-grid2" style={{ marginTop: '4mm' }}>
                {f.happyTrack && (
                  <div className="doc-moment">
                    <Thumb src={f.happyTrack.cover} name={f.happyTrack.track} size={40} />
                    <div className="min-w-0">
                      <div className="doc-kicker" style={{ color: MOOD_HEX.euforico }}>
                        Il più solare tra i preferiti
                      </div>
                      <div className="doc-strong doc-trunc">{f.happyTrack.track}</div>
                      <div className="doc-sub">{f.happyTrack.artist} · positività {Math.round(f.happyTrack.valence * 100)}/100</div>
                    </div>
                  </div>
                )}
                {f.sadTrack && (
                  <div className="doc-moment">
                    <Thumb src={f.sadTrack.cover} name={f.sadTrack.track} size={40} />
                    <div className="min-w-0">
                      <div className="doc-kicker" style={{ color: MOOD_HEX.malinconico }}>
                        Il più cupo
                      </div>
                      <div className="doc-strong doc-trunc">{f.sadTrack.track}</div>
                      <div className="doc-sub">{f.sadTrack.artist} · positività {Math.round(f.sadTrack.valence * 100)}/100</div>
                    </div>
                  </div>
                )}
              </div>
            )}
            <p className="doc-note">Felice/triste = media della positività (valence) dei brani pesata sul tempo; carico/calmo = stessa cosa con l’energia. Solo giorni con almeno 45 minuti di mood noto.</p>
          </>
        ) : (
          <p className="doc-lead">Mood non ancora calcolato: attiva le audio features o il mood AI nelle Impostazioni e rigenera il PDF.</p>
        )}
      </Page>

      {has.map && <MapPage x={x} kicker={kick('map')} />}
      {has.eras && <ErasPage x={x} kicker={kick('eras')} />}
      {has.artists && <ArtistsPage x={x} kicker={kick('artists')} />}
      {has.skip && <SkipPage x={x} kicker={kick('skip')} />}

      {/* 8 · Habits */}
      <Page id="habits" kicker={kick('habits')} title="Come ascolti">
        <Kpis
          items={[
            { label: 'brani saltati', value: fmtPct(f.skip) },
            { label: 'riproduzione casuale', value: fmtPct(f.shuffle) },
            { label: 'scoperte', value: fmtPct(k.discovery_rate), sub: 'ascolti di brani nuovi' },
            { label: 'sessioni', value: fmtInt(k.sessions), sub: `${fmtHours(f.minutes / Math.max(1, k.sessions))} in media` },
          ]}
          cols={4}
        />
        <div className="doc-cols">
          <div>
            <H3>Dispositivi</H3>
            <HBars rows={r.platforms.map((p) => ({ label: p.label, value: p.minutes / totalPlatform })).filter((p) => p.value >= 0.005)} fmt={(v) => fmtPct(v)} />
            <H3>Come finisce un brano</H3>
            <HBars rows={r.endings.map((p) => ({ label: reasonLabel(p.label), value: p.n / totalEnd })).filter((p) => p.value >= 0.005)} fmt={(v) => fmtPct(v)} />
          </div>
          <div>
            <H3>Paesi</H3>
            <HBars rows={r.countries.map((c) => ({ label: countryName(c.label), value: c.minutes, note: `${fmtInt(c.days)} gg` }))} fmt={fmtHours} />
            {r.discovery.length > 1 && (
              <>
                <H3>Artisti scoperti per anno</H3>
                <HBars rows={r.discovery.map((d) => ({ label: String(d.year), value: d.n }))} fmt={(v) => `${fmtInt(v)} artisti`} />
              </>
            )}
            <SessionKinds x={x} />
          </div>
        </div>
        <p className="doc-note">
          “Ascolto” = almeno 30 secondi. Sessione = ascolti separati da meno di 30 minuti. Copertine da Spotify, audio features da ReccoBeats, mood stimato dove mancanti.
          {r.excluded > 0 && ` ${fmtInt(r.excluded)} ${r.excluded === 1 ? 'brano escluso' : 'brani esclusi'} dalle statistiche (Impostazioni → Esclusi).`}
        </p>
      </Page>
    </>
  );
}

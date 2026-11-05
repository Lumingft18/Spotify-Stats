// One-click PDF: every section of the app stacked on one page, rendered by the browser itself
// (vector text and charts, same colours and desktop layout), then handed to the print dialog → "Salva come PDF".
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, FileDown, Printer } from 'lucide-react';
import { useSql, useSqlOne } from '../../data/useSql';
import { KPI_SQL, topSql, type Kpi, type TopRow } from '../../data/queries';
import { useApp } from '../../lib/store';
import { periodLabel } from '../../lib/storyCard';
import { fmtDate, fmtHours, fmtInt } from '../../lib/format';
import { Button, Spinner } from '../../components/ui';
import { Overview } from '../overview/Overview';
import { runAllEnabled, stopAll } from '../../enrichment/jobs';
import { holdEnrichment } from '../../enrichment/pause';

const Explore = lazy(() => import('../explore/Explore'));
const ArtistPage = lazy(() => import('../explore/ArtistPage'));
const TrackPage = lazy(() => import('../explore/TrackPage'));
const AlbumPage = lazy(() => import('../explore/AlbumPage'));
const TimePage = lazy(() => import('../time/TimePage'));
const MoodPage = lazy(() => import('../mood/MoodPage'));
const InsightsPage = lazy(() => import('../insights/InsightsPage'));
const StoryPage = lazy(() => import('../story/StoryPage'));
const ProfilePage = lazy(() => import('../profile/ProfilePage'));
const ComparePage = lazy(() => import('../compare/ComparePage'));
const AskPage = lazy(() => import('../ask/AskPage'));

/** Width the whole report is laid out at, on screen and on paper (@page in index.css uses the same). */
export const REPORT_WIDTH = 1280;

function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`r-${id}`} className="report-part" aria-label={title}>
      <div className="report-part-title">{title}</div>
      <Suspense fallback={<Spinner />}>{children}</Suspense>
    </section>
  );
}

/** Ready = no skeletons, no loading spinners (outside buttons), every image settled — stable for 2.5 s. */
function useReady(root: React.RefObject<HTMLElement | null>, maxMs = 90_000) {
  const [state, setState] = useState<{ ready: boolean; pending: number; timedOut: boolean }>({ ready: false, pending: 1, timedOut: false });
  useEffect(() => {
    const t0 = Date.now();
    let stableSince = 0;
    const id = setInterval(() => {
      const el = root.current;
      if (!el) return;
      const skeletons = el.querySelectorAll('.skeleton').length;
      const spinners = Array.from(el.querySelectorAll('[aria-label="caricamento"]')).filter((s) => !s.closest('button')).length;
      const images = Array.from(el.querySelectorAll('img')).filter((i) => !i.complete).length;
      const pending = skeletons + spinners + images;
      const now = Date.now();
      if (pending === 0) stableSince ||= now;
      else stableSince = 0;
      const timedOut = now - t0 > maxMs;
      const ready = (stableSince > 0 && now - stableSince > 2500) || timedOut;
      setState({ ready, pending, timedOut: timedOut && pending > 0 });
      if (ready) clearInterval(id);
    }, 500);
    return () => clearInterval(id);
  }, [root, maxMs]);
  return state;
}

export default function ReportPage() {
  const root = useRef<HTMLDivElement>(null);
  const range = useApp((s) => s.range);
  const profile = useApp((s) => s.profile);
  const k = useSqlOne<Kpi>(KPI_SQL).row;
  const topArtist = useSql<TopRow>(topSql('artists', 'minutes', 1)).data?.[0];
  const topTrack = useSql<TopRow>(topSql('tracks', 'minutes', 1)).data?.[0];
  const topAlbum = useSql<TopRow>(topSql('albums', 'minutes', 1)).data?.[0];
  const { ready, pending, timedOut } = useReady(root);
  const printed = useRef(false);
  const [done, setDone] = useState(false);
  const name = profile?.displayName ?? profile?.username ?? null;
  const today = new Date().toISOString().slice(0, 10);

  // Freeze background enrichment while the report is open: a consistent snapshot, and the page can settle.
  useEffect(() => {
    holdEnrichment(true);
    stopAll();
    return () => {
      holdEnrichment(false);
      runAllEnabled();
    };
  }, []);

  // Covers are lazy-loaded in the app: off-screen ones would never load (nor print). Force them eager here.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const eager = () => el.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((i) => (i.loading = 'eager'));
    eager();
    const mo = new MutationObserver(eager);
    mo.observe(el, { subtree: true, childList: true });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('report-mode');
    const prevTitle = document.title;
    // The title becomes the default PDF file name.
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
    // Let the last layout settle (charts re-measure) before opening the dialog.
    requestAnimationFrame(() => setTimeout(() => window.print(), 300));
  }, [ready, autoPrint]);

  const parts: Array<{ id: string; title: string; node: ReactNode; show?: boolean }> = [
    { id: 'overview', title: 'Panoramica', node: <Overview /> },
    { id: 'artists', title: 'Esplora · Artisti', node: <Explore kind="artists" /> },
    { id: 'tracks', title: 'Esplora · Brani', node: <Explore kind="tracks" /> },
    { id: 'albums', title: 'Esplora · Album', node: <Explore kind="albums" /> },
    { id: 'artist', title: `Artista · ${topArtist?.label ?? ''}`, node: topArtist && <ArtistPage name={topArtist.label} />, show: !!topArtist },
    { id: 'track', title: `Brano · ${topTrack?.label ?? ''}`, node: topTrack?.uri && <TrackPage uri={topTrack.uri} />, show: !!topTrack?.uri },
    { id: 'album', title: `Album · ${topAlbum?.label ?? ''}`, node: topAlbum && <AlbumPage artist={topAlbum.artist} album={topAlbum.label} />, show: !!topAlbum },
    { id: 'time', title: 'Tempo', node: <TimePage /> },
    { id: 'mood', title: 'Mood & Galassia', node: <MoodPage /> },
    { id: 'insights', title: 'Modelli', node: <InsightsPage /> },
    { id: 'story', title: 'Racconto', node: <StoryPage /> },
    { id: 'profile', title: 'Profilo', node: <ProfilePage /> },
    { id: 'compare', title: 'Confronta', node: <ComparePage /> },
    { id: 'ask', title: 'Chiedi', node: <AskPage /> },
  ];
  const visible = parts.filter((p) => p.show !== false);

  return (
    <div className="report-root page-glow min-h-screen">
      <div className="report-toolbar no-print">
        <a href="#/" className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text">
          <ArrowLeft size={16} /> Torna all’app
        </a>
        <div className="flex items-center gap-3 text-sm text-text-muted" aria-live="polite">
          {!ready ? (
            <>
              <Spinner /> Preparo il PDF… {pending > 0 && <span className="num">{fmtInt(pending)} elementi in caricamento</span>}
            </>
          ) : (
            <>
              <FileDown size={16} className="text-[var(--accent)]" />
              {done ? 'Fatto.' : 'Pronto.'} Nella finestra di stampa scegli “Salva come PDF”.
              {timedOut && <span className="text-bad">Alcuni elementi non si sono caricati in tempo.</span>}
            </>
          )}
          <Button size="sm" variant="primary" disabled={!ready} onClick={() => window.print()}>
            <Printer size={14} /> {done ? 'Salva di nuovo' : 'Salva PDF'}
          </Button>
        </div>
      </div>

      <div ref={root} className="report" style={{ width: REPORT_WIDTH }}>
        <section className="report-part report-cover">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-text-faint">Ascolti · report completo</div>
          <h1 className="display mt-4 text-8xl leading-none">{name ? `La musica di ${name}` : 'La tua musica'}</h1>
          <p className="mt-4 text-2xl text-text-muted">
            {periodLabel(range)}
            {k?.first_day ? ` · ${fmtDate(k.first_day)} — ${fmtDate(k.last_day)}` : ''}
          </p>
          {k && (
            <p className="num mt-2 text-lg text-text-muted">
              {fmtHours(k.minutes)} · {fmtInt(k.plays)} ascolti · {fmtInt(k.tracks)} brani · {fmtInt(k.artists)} artisti
            </p>
          )}
          <ol className="mt-12 grid grid-cols-2 gap-x-12 gap-y-2 text-lg">
            {visible.map((p, i) => (
              <li key={p.id} className="flex gap-3">
                <span className="num w-8 text-text-faint">{String(i + 1).padStart(2, '0')}</span>
                <span className="truncate">{p.title}</span>
              </li>
            ))}
          </ol>
          <p className="mt-12 text-sm text-text-faint">Generato il {fmtDate(today)} · calcolato sul tuo dispositivo, nessun dato inviato per creare questo PDF.</p>
        </section>
        {visible.map((p) => (
          <Part key={p.id} id={p.id} title={p.title}>
            {p.node}
          </Part>
        ))}
      </div>
    </div>
  );
}

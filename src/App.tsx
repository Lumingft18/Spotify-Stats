import { useEffect, lazy, Suspense } from 'react';
import { prewarm, restore } from './data/db';
import { afterDataLoaded, importNextQueued } from './data/lifecycle';
import { refreshQueue, takeAutoStart } from './lib/importQueue';
import { useApp, getApp } from './lib/store';
import { apiAvailable } from './lib/api';
import { analyses, currentAnalysisId, setCurrentAnalysis } from './lib/analyses';
import { migrateLegacy } from './lib/migrate';
import { useRoute } from './lib/router';
import { Shell } from './components/Shell';
import { Onboarding } from './features/onboarding/Onboarding';
import { Overview } from './features/overview/Overview';
import { Spinner } from './components/ui';

const Explore = lazy(() => import('./features/explore/Explore'));
const ArtistPage = lazy(() => import('./features/explore/ArtistPage'));
const TrackPage = lazy(() => import('./features/explore/TrackPage'));
const AlbumPage = lazy(() => import('./features/explore/AlbumPage'));
const TimePage = lazy(() => import('./features/time/TimePage'));
const MoodPage = lazy(() => import('./features/mood/MoodPage'));
const InsightsPage = lazy(() => import('./features/insights/InsightsPage'));
const AskPage = lazy(() => import('./features/ask/AskPage'));
const StoryPage = lazy(() => import('./features/story/StoryPage'));
const ComparePage = lazy(() => import('./features/compare/ComparePage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
const ProfilePage = lazy(() => import('./features/profile/ProfilePage'));
const ReportPage = lazy(() => import('./features/report/ReportPage'));
const CompareReport = lazy(() => import('./features/compare/CompareReport'));

function Router() {
  const { path } = useRoute();
  const [a, b, c] = path;
  switch (a) {
    case undefined:
      return <Overview />;
    case 'explore':
      return <Explore />;
    case 'artist':
      return <ArtistPage name={b ?? ''} />;
    case 'track':
      return <TrackPage uri={b ?? ''} />;
    case 'album':
      return <AlbumPage artist={b ?? ''} album={c ?? ''} />;
    case 'time':
      return <TimePage />;
    case 'mood':
      return <MoodPage />;
    case 'insights':
      return <InsightsPage />;
    case 'ask':
      return <AskPage />;
    case 'story':
      return <StoryPage />;
    case 'compare':
      return <ComparePage />;
    case 'settings':
      return <SettingsPage />;
    case 'profile':
      return <ProfilePage />;
    default:
      return <Overview />;
  }
}

/** The PDF report renders without the app chrome (sidebar, top bar). */
function ReportRoute({ compare = false }: { compare?: boolean }) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 p-10 text-text-muted">
          <Spinner /> Caricamento…
        </div>
      }
    >
      {compare ? <CompareReport /> : <ReportPage />}
    </Suspense>
  );
}

// React StrictMode runs effects twice in dev: boot (migration, restore) must happen once per page load.
let booting: Promise<void> | null = null;
const bootOnce = () => (booting ??= boot());

/** Opens the analysis this browser had open (if it still exists); otherwise the start screen with the history. */
async function boot() {
  if (!(await apiAvailable())) {
    getApp().set({ status: 'empty', serverUp: false });
    return;
  }
  await migrateLegacy().catch((e) => console.warn('migrazione dati del browser', e));
  const autoStart = takeAutoStart();
  await refreshQueue();
  const id = currentAnalysisId();
  if (id) {
    const a = await analyses.get(id).catch(() => null);
    if (!a) setCurrentAnalysis(null);
    else {
      getApp().set({ analysis: a });
      if (await restore()) return afterDataLoaded();
      setCurrentAnalysis(null); // created but never filled (import interrupted): stays in the history list
      getApp().set({ analysis: null });
    }
  }
  getApp().set({ status: 'empty' });
  // Previous person finished enriching: import the next one in the queue.
  if (autoStart) await importNextQueued();
}

export default function App() {
  const status = useApp((s) => s.status);
  const route0 = useRoute().path[0];
  const isReport = route0 === 'report' || route0 === 'report-compare';

  useEffect(() => {
    prewarm();
    void bootOnce().catch((e) => {
      console.error(e);
      getApp().set({ status: 'empty' });
    });
  }, []);

  if (status === 'booting') {
    return (
      <div className="page-glow flex min-h-screen items-center justify-center gap-3 text-text-muted">
        <Spinner size={18} /> Apro i tuoi ascolti…
      </div>
    );
  }
  if (status !== 'ready') return <Onboarding />;
  if (isReport) return <ReportRoute compare={route0 === 'report-compare'} />;
  return (
    <Shell>
      <Suspense
        fallback={
          <div className="flex items-center gap-2 py-20 text-text-muted">
            <Spinner /> Caricamento…
          </div>
        }
      >
        <Router />
      </Suspense>
    </Shell>
  );
}

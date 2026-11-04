import { useEffect, lazy, Suspense } from 'react';
import { prewarm, restore } from './data/db';
import { afterDataLoaded } from './data/lifecycle';
import { useApp, getApp } from './lib/store';
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

export default function App() {
  const status = useApp((s) => s.status);

  useEffect(() => {
    prewarm();
    restore()
      .then((ok) => (ok ? afterDataLoaded() : getApp().set({ status: 'empty' })))
      .catch((e) => {
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

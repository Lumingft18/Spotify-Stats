import { type ReactNode, useEffect } from 'react';
import {
  LayoutGrid,
  Compass,
  CalendarClock,
  Orbit,
  BrainCircuit,
  MessageCircle,
  BookOpen,
  Users,
  UserRound,
  Settings,
  Activity,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useRoute, routes } from '../lib/router';
import { useApp } from '../lib/store';
import { cx, Kbd } from './ui';
import { TimeFilter } from './TimeFilter';
import { CommandPalette } from './CommandPalette';
import { ActivityDrawer } from './ActivityDrawer';

const NAV = [
  { key: '', href: routes.overview(), label: 'Panoramica', icon: LayoutGrid, mobile: true },
  { key: 'explore', href: routes.explore(), label: 'Esplora', icon: Compass, mobile: true, also: ['artist', 'track', 'album'] },
  { key: 'time', href: routes.time(), label: 'Tempo', icon: CalendarClock, mobile: true },
  { key: 'mood', href: routes.mood(), label: 'Mood & Galassia', icon: Orbit, mobile: true },
  { key: 'insights', href: routes.insights(), label: 'Modelli', icon: BrainCircuit },
  { key: 'ask', href: routes.ask(), label: 'Chiedi', icon: MessageCircle, mobile: true },
  { key: 'story', href: routes.story(), label: 'Racconto', icon: BookOpen },
  { key: 'compare', href: routes.compare(), label: 'Confronta', icon: Users },
  { key: 'profile', href: routes.profile(), label: 'Profilo', icon: UserRound },
];

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useRoute();
  const current = path[0] ?? '';
  const jobs = useApp((s) => s.jobs);
  const set = useApp((s) => s.set);
  const profileName = useApp((s) => s.profile?.displayName ?? s.profile?.username ?? null);
  const running = Object.values(jobs).filter((j) => j.status === 'running');
  const isStory = current === 'story';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        set({ paletteOpen: !useApp.getState().paletteOpen });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  const active = (n: (typeof NAV)[number]) => n.key === current || (n.also?.includes(current) ?? false);

  return (
    <div className="page-glow min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50">
        Vai al contenuto
      </a>
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-bg/70 px-3 py-5 backdrop-blur-xl lg:flex">
        <a href={routes.overview()} className="mb-6 flex items-center gap-2 px-3">
          <img src="/favicon.svg" alt="" width={28} height={28} className="rounded-lg" />
          <span className="display text-2xl">Ascolti</span>
        </a>
        <button
          onClick={() => set({ paletteOpen: true })}
          className="mb-4 flex h-9 items-center gap-2 rounded-full border border-border bg-surface-1 px-3 text-sm text-text-faint hover:text-text"
        >
          <Search size={15} />
          <span className="flex-1 text-left">Cerca…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <nav className="flex flex-col gap-0.5" aria-label="Sezioni">
          {NAV.map((n) => (
            <a
              key={n.key}
              href={n.href}
              aria-current={active(n) ? 'page' : undefined}
              className={cx(
                'flex h-9 items-center gap-3 rounded-full px-3 text-sm transition-colors',
                active(n) ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-1 hover:text-text',
              )}
            >
              <n.icon size={17} className={active(n) ? 'text-[var(--accent)]' : ''} />
              {n.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-0.5">
          <button
            onClick={() => set({ activityOpen: true })}
            className="flex h-9 items-center gap-3 rounded-full px-3 text-sm text-text-muted hover:bg-surface-1 hover:text-text"
          >
            <Activity size={17} className={running.length ? 'animate-pulse text-[var(--accent)]' : ''} />
            Attività {running.length > 0 && <span className="num text-xs text-[var(--accent)]">{running.length}</span>}
          </button>
          <a
            href={routes.settings()}
            className={cx(
              'flex h-9 items-center gap-3 rounded-full px-3 text-sm',
              current === 'settings' ? 'bg-surface-2 text-text' : 'text-text-muted hover:bg-surface-1 hover:text-text',
            )}
          >
            <Settings size={17} /> Impostazioni
          </a>
          {profileName && (
            <a href={routes.profile()} className="mt-3 flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-text-muted hover:bg-surface-1 hover:text-text">
              <span className="grid size-6 place-items-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-accent-ink">{profileName[0]?.toUpperCase()}</span>
              <span className="truncate">{profileName}</span>
            </a>
          )}
          <div className="mt-3 flex items-center gap-2 px-3 text-[11px] text-text-faint">
            <ShieldCheck size={13} className="text-good" /> Dati solo sul tuo dispositivo
          </div>
        </div>
      </aside>

      {/* Top bar */}
      {!isStory && (
        <header className="sticky top-0 z-20 border-b border-border bg-bg/70 backdrop-blur-xl lg:pl-60">
          <div className="mx-auto flex h-14 w-full max-w-[2880px] items-center gap-3 px-4 md:px-8 2xl:px-14">
            <a href={routes.overview()} className="display text-xl lg:hidden">
              Ascolti
            </a>
            <div className="min-w-0 flex-1">
              <TimeFilter />
            </div>
            <button
              onClick={() => set({ paletteOpen: true })}
              className="grid size-9 place-items-center rounded-full text-text-muted hover:bg-surface-2 lg:hidden"
              aria-label="Cerca"
            >
              <Search size={18} />
            </button>
            <button
              onClick={() => set({ activityOpen: true })}
              className="grid size-9 place-items-center rounded-full text-text-muted hover:bg-surface-2 lg:hidden"
              aria-label="Attività"
            >
              <Activity size={18} className={running.length ? 'animate-pulse text-[var(--accent)]' : ''} />
            </button>
            <a href={routes.settings()} className="grid size-9 place-items-center rounded-full text-text-muted hover:bg-surface-2 lg:hidden" aria-label="Impostazioni">
              <Settings size={18} />
            </a>
          </div>
        </header>
      )}

      <main id="main" className="lg:pl-60">
        {isStory ? children : <div className="mx-auto w-full max-w-[2880px] px-4 pb-28 pt-8 md:px-8 lg:pb-16 lg:pt-10 2xl:px-14">{children}</div>}
      </main>

      {/* Mobile bottom nav */}
      <nav
        aria-label="Sezioni principali"
        className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-border bg-bg/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
      >
        {NAV.filter((n) => n.mobile).map((n) => (
          <a
            key={n.key}
            href={n.href}
            aria-current={active(n) ? 'page' : undefined}
            className={cx('flex flex-1 flex-col items-center gap-1 py-2 text-[10px]', active(n) ? 'text-text' : 'text-text-faint')}
          >
            <n.icon size={20} className={active(n) ? 'text-[var(--accent)]' : ''} />
            {n.label.split(' ')[0]}
          </a>
        ))}
      </nav>

      <CommandPalette />
      <ActivityDrawer />
    </div>
  );
}

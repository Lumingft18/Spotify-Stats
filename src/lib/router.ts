import { useSyncExternalStore } from 'react';

// Tiny hash router: "#/artist/Lana%20Del%20Rey?tab=x" → { path: ['artist','Lana Del Rey'], query }.

export interface Route {
  path: string[];
  query: URLSearchParams;
  raw: string;
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [p, q = ''] = raw.split('?');
  const path = p
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { path, query: new URLSearchParams(q), raw };
}

let current = parse(typeof location !== 'undefined' ? location.hash : '');
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parse(location.hash);
    listeners.forEach((l) => l());
  });
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function href(...segments: Array<string | number>): string {
  return '#/' + segments.map((s) => encodeURIComponent(String(s))).join('/');
}

export function navigate(to: string) {
  const target = to.startsWith('#') ? to : '#' + to;
  if (location.hash === target) return;
  const go = () => {
    location.hash = target;
    window.scrollTo({ top: 0 });
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(go);
  else go();
}

export const routes = {
  overview: () => '#/',
  explore: (kind: 'artists' | 'tracks' | 'albums' = 'artists') => `#/explore?kind=${kind}`,
  artist: (name: string) => href('artist', name),
  track: (uri: string) => href('track', uri),
  album: (artist: string, album: string) => href('album', artist, album),
  time: () => '#/time',
  mood: () => '#/mood',
  insights: () => '#/insights',
  ask: (q?: string) => (q ? `#/ask?q=${encodeURIComponent(q)}` : '#/ask'),
  story: (year?: number) => (year ? `#/story?year=${year}` : '#/story'),
  compare: () => '#/compare',
  settings: () => '#/settings',
  profile: () => '#/profile',
};

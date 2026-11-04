import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { Disc3, Mic2, Music, Sparkles, ArrowRight } from 'lucide-react';
import { useApp } from '../lib/store';
import { navigate, routes } from '../lib/router';
import { query } from '../data/db';
import { Cover } from './Cover';
import { fmtHours } from '../lib/format';

interface Hit {
  kind: 'artist' | 'track' | 'album';
  label: string;
  sub: string;
  uri?: string;
  artist: string;
  cover: string | null;
  minutes: number;
}

const PAGES = [
  ['Panoramica', routes.overview()],
  ['Esplora artisti', routes.explore('artists')],
  ['Esplora brani', routes.explore('tracks')],
  ['Esplora album', routes.explore('albums')],
  ['Tempo e abitudini', routes.time()],
  ['Mood & Galassia', routes.mood()],
  ['Modelli: skip, ere, riscoperta', routes.insights()],
  ['Chiedi ai tuoi dati', routes.ask()],
  ['Racconto dell’anno', routes.story()],
  ['Confronta con un amico', routes.compare()],
  ['Impostazioni e privacy', routes.settings()],
] as const;

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const set = useApp((s) => s.set);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);

  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    let alive = true;
    const like = `%${q.trim().toLowerCase()}%`;
    const t = setTimeout(() => {
      void query<Hit>(
        `(SELECT 'artist' AS kind, artist AS label, count(*)::VARCHAR || ' brani' AS sub, NULL uri, artist, any_value(cover) AS cover, sum(minutes) AS minutes
          FROM tracks LEFT JOIN meta USING (uri) WHERE lower(artist) LIKE ? GROUP BY artist ORDER BY minutes DESC LIMIT 5)
         UNION ALL
         (SELECT 'track', track, artist, uri, artist, cover, minutes FROM tracks LEFT JOIN meta USING (uri)
          WHERE lower(track) LIKE ? ORDER BY minutes DESC LIMIT 6)
         UNION ALL
         (SELECT 'album', album, artist, NULL, artist, any_value(cover), sum(minutes) FROM tracks LEFT JOIN meta USING (uri)
          WHERE lower(album) LIKE ? GROUP BY album, artist ORDER BY 7 DESC LIMIT 4)`,
        [like, like, like],
      ).then((r) => alive && setHits(r));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, open]);

  if (!open) return null;
  const visibleHits = q.trim().length >= 2 ? hits : [];
  const close = () => {
    set({ paletteOpen: false });
    setQ('');
  };
  const go = (to: string) => {
    close();
    navigate(to);
  };
  const icon = { artist: Mic2, track: Music, album: Disc3 };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm" onClick={close}>
      <div className="w-full max-w-xl animate-rise" onClick={(e) => e.stopPropagation()}>
        <Command
          label="Cerca"
          shouldFilter={false}
          className="overflow-hidden rounded-2xl border border-border bg-surface-1 shadow-2xl"
          onKeyDown={(e) => e.key === 'Escape' && close()}
        >
          <Command.Input
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder="Cerca artisti, brani, album o pagine…"
            className="h-14 w-full border-b border-border bg-transparent px-5 text-base text-text outline-none placeholder:text-text-faint"
          />
          <Command.List className="scrollbar-thin max-h-[60vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-sm text-text-faint">Nessun risultato.</Command.Empty>
            {q.trim().length >= 3 && (
              <Command.Group heading="Chiedi">
                <Command.Item
                  value={`ask-${q}`}
                  onSelect={() => go(routes.ask(q))}
                  className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm"
                >
                  <Sparkles size={16} className="text-[var(--accent)]" />
                  <span className="flex-1 truncate">Chiedi: “{q}”</span>
                  <ArrowRight size={14} className="text-text-faint" />
                </Command.Item>
              </Command.Group>
            )}
            {visibleHits.length > 0 && (
              <Command.Group heading="Nella tua libreria">
                {visibleHits.map((h, i) => {
                  const Icon = icon[h.kind];
                  return (
                    <Command.Item
                      key={`${h.kind}-${i}-${h.label}`}
                      value={`${h.kind}-${i}-${h.label}`}
                      onSelect={() =>
                        go(h.kind === 'artist' ? routes.artist(h.label) : h.kind === 'track' ? routes.track(h.uri!) : routes.album(h.artist, h.label))
                      }
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm"
                    >
                      <Cover src={h.cover} name={h.label} size={34} round={h.kind === 'artist'} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-text">{h.label}</div>
                        <div className="flex items-center gap-1 truncate text-xs text-text-faint">
                          <Icon size={11} /> {h.kind === 'artist' ? 'Artista' : h.kind === 'track' ? 'Brano' : 'Album'} · {h.sub}
                        </div>
                      </div>
                      <span className="num text-xs text-text-faint">{fmtHours(h.minutes)}</span>
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}
            {PAGES.some(([l]) => !q || l.toLowerCase().includes(q.toLowerCase())) && (
            <Command.Group heading="Vai a">
              {PAGES.filter(([l]) => !q || l.toLowerCase().includes(q.toLowerCase())).map(([label, to]) => (
                <Command.Item
                  key={to}
                  value={`page-${label}`}
                  onSelect={() => go(to)}
                  className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-text-muted"
                >
                  <ArrowRight size={14} />
                  {label}
                </Command.Item>
              ))}
            </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

// Parser for Spotify's "Account data" package (MyData/*.json): identity, library, playlists,
// searches, inferences, Wrapped. Robust to missing files and schema drift (all fields optional).

export interface AccountProfile {
  displayName: string | null;
  username: string | null;
  country: string | null;
  createdAt: string | null; // YYYY-MM-DD
  library: { tracks: number; albums: number; artists: number; shows: number; episodes: number };
  likedTracks: Array<{ uri: string; track: string; artist: string; album: string }>;
  playlists: Array<{ name: string; lastModified: string | null; tracks: number; followers: number; sample: string[] }>;
  searches: Array<{ query: string; at: string }>;
  inferences: string[];
  wrapped: Array<{ year: number; summary: Record<string, unknown> }>;
  files: string[];
  importedAt: number;
}

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);

export function isAccountFile(name: string): boolean {
  const base = (name.split('/').pop() ?? '').toLowerCase();
  if (!base.endsWith('.json') || base.startsWith('._')) return false;
  return /^(identity|userdata|yourlibrary|playlist\d*|searchqueries|inferences|wrapped\d{4}|follow|marquee)\.json$/.test(base);
}

export function emptyProfile(): AccountProfile {
  return {
    displayName: null,
    username: null,
    country: null,
    createdAt: null,
    library: { tracks: 0, albums: 0, artists: 0, shows: 0, episodes: 0 },
    likedTracks: [],
    playlists: [],
    searches: [],
    inferences: [],
    wrapped: [],
    files: [],
    importedAt: Date.now(),
  };
}

/** Merges one parsed account JSON file into the profile. */
export function applyAccountFile(p: AccountProfile, name: string, data: unknown): void {
  const base = (name.split('/').pop() ?? '').toLowerCase();
  const o = (data && typeof data === 'object' ? data : {}) as J;
  p.files.push(base);
  if (base === 'identity.json') {
    p.displayName = s(o.displayName) ?? ([s(o.firstName), s(o.lastName)].filter(Boolean).join(' ') || p.displayName);
  } else if (base === 'userdata.json') {
    p.username = s(o.username) ?? p.username;
    p.country = s(o.country) ?? p.country;
    const c = s(o.creationTime);
    if (c) p.createdAt = c.slice(0, 10);
    if (!p.displayName) p.displayName = s(o.name) ?? s(o.displayName);
  } else if (base === 'yourlibrary.json') {
    const tracks = arr(o.tracks);
    p.library = {
      tracks: tracks.length,
      albums: arr(o.albums).length,
      artists: arr(o.artists).length,
      shows: arr(o.shows).length,
      episodes: arr(o.episodes).length,
    };
    p.likedTracks = tracks
      .map((t) => ({ uri: s(t.uri) ?? '', track: s(t.track) ?? '', artist: s(t.artist) ?? '', album: s(t.album) ?? '' }))
      .filter((t) => t.track);
  } else if (/^playlist\d*\.json$/.test(base)) {
    for (const pl of arr(o.playlists)) {
      const items = arr(pl.items);
      p.playlists.push({
        name: s(pl.name) ?? 'Senza nome',
        lastModified: s(pl.lastModifiedDate),
        tracks: items.length,
        followers: Number(pl.numberOfFollowers ?? 0) || 0,
        sample: items
          .slice(0, 5)
          .map((it) => {
            const t = (it.track ?? {}) as J;
            return [s(t.trackName), s(t.artistName)].filter(Boolean).join(' — ');
          })
          .filter(Boolean),
      });
    }
  } else if (base === 'searchqueries.json') {
    const list = Array.isArray(data) ? (data as J[]) : arr(o.searchQueries);
    for (const q of list) {
      const query = s(q.searchQuery);
      if (query) p.searches.push({ query, at: (s(q.searchTime) ?? '').slice(0, 10) });
    }
  } else if (base === 'inferences.json') {
    p.inferences = (Array.isArray(o.inferences) ? (o.inferences as unknown[]) : [])
      .filter((x): x is string => typeof x === 'string' && !!x)
      .filter((x, i, all) => all.indexOf(x) === i)
      .slice(0, 400);
  } else if (/^wrapped\d{4}\.json$/.test(base)) {
    p.wrapped.push({ year: Number(base.slice(7, 11)), summary: o });
  }
}

/** Track-name → URI lookup built from library + playlists, used to give legacy history rows real Spotify URIs. */
export function uriLookup(files: Array<{ name: string; data: unknown }>): Map<string, string> {
  const m = new Map<string, string>();
  const key = (track: string, artist: string) => `${track.toLowerCase()}|${artist.toLowerCase()}`;
  for (const f of files) {
    const base = (f.name.split('/').pop() ?? '').toLowerCase();
    const o = (f.data && typeof f.data === 'object' ? f.data : {}) as J;
    if (base === 'yourlibrary.json') {
      for (const t of arr(o.tracks)) {
        const u = s(t.uri);
        if (u && s(t.track) && s(t.artist)) m.set(key(s(t.track)!, s(t.artist)!), u);
      }
    } else if (/^playlist\d*\.json$/.test(base)) {
      for (const pl of arr(o.playlists))
        for (const it of arr(pl.items)) {
          const t = (it.track ?? {}) as J;
          const u = s(t.trackUri);
          if (u && s(t.trackName) && s(t.artistName)) m.set(key(s(t.trackName)!, s(t.artistName)!), u);
        }
    }
  }
  return m;
}

export const profileFirstName = (p: AccountProfile | null) => {
  const n = p?.displayName ?? null;
  if (!n) return null;
  return n.split(/\s+/)[0];
};

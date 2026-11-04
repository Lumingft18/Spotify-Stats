import type { MetaRow } from '../data/schema';
import { netFetch } from './net';

export interface TrackRef {
  uri: string;
  track: string;
  artist: string;
  album: string;
  duration_ms: number | null;
}

export const spotifyId = (uri: string) => (uri.startsWith('spotify:track:') ? uri.slice(14) : null);

/** Cover art via Spotify's public oEmbed endpoint (no auth, CORS-enabled). */
export async function fetchCover(t: TrackRef, signal: AbortSignal): Promise<MetaRow | null> {
  const id = spotifyId(t.uri);
  if (!id) return null;
  const res = await netFetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`,
    'copertine',
    { signal },
  );
  if (!res.ok) return res.status === 404 ? { uri: t.uri, cover: '' } : null;
  const j = (await res.json()) as { thumbnail_url?: string };
  return { uri: t.uri, cover: j.thumbnail_url ?? '' };
}

/** Spotify-style audio features by Spotify ID (ReccoBeats, batch ≤ 40). */
export async function fetchAudioFeatures(batch: TrackRef[], signal: AbortSignal): Promise<MetaRow[]> {
  const ids = batch.map((t) => spotifyId(t.uri)).filter(Boolean) as string[];
  if (!ids.length) return [];
  const res = await netFetch(`https://api.reccobeats.com/v1/audio-features?ids=${ids.join(',')}`, 'audio features', {
    signal,
  });
  if (!res.ok) throw new Error(`ReccoBeats HTTP ${res.status}`);
  const j = (await res.json()) as {
    content?: Array<{
      href: string;
      valence: number;
      energy: number;
      danceability: number;
      tempo: number;
      acousticness: number;
    }>;
  };
  const byId = new Map(batch.map((t) => [spotifyId(t.uri), t.uri]));
  return (j.content ?? [])
    .map((c) => {
      const id = c.href?.split('/').pop() ?? '';
      const uri = byId.get(id);
      if (!uri) return null;
      return {
        uri,
        valence: c.valence,
        energy: c.energy,
        danceability: c.danceability,
        tempo: c.tempo,
        acousticness: c.acousticness,
        mood_source: 'reccobeats',
        mood_conf: 1,
      } satisfies MetaRow;
    })
    .filter(Boolean) as MetaRow[];
}

/** Plain lyrics from LRCLIB (free, no key). Returns '' when not found so we don't retry forever. */
export async function fetchLyrics(t: TrackRef, signal: AbortSignal): Promise<MetaRow | null> {
  const qs = new URLSearchParams({ artist_name: t.artist, track_name: t.track });
  if (t.album) qs.set('album_name', t.album);
  if (t.duration_ms) qs.set('duration', String(Math.round(t.duration_ms / 1000)));
  let res = await netFetch(`https://lrclib.net/api/get?${qs}`, 'testi', { signal });
  if (res.status === 404) {
    // Fallback: search without album/duration constraints.
    const s = new URLSearchParams({ artist_name: t.artist, track_name: t.track });
    res = await netFetch(`https://lrclib.net/api/search?${s}`, 'testi', { signal });
    if (!res.ok) return { uri: t.uri, lyrics: '' };
    const arr = (await res.json()) as Array<{ plainLyrics?: string; instrumental?: boolean }>;
    const hit = arr.find((a) => a.plainLyrics);
    return { uri: t.uri, lyrics: hit?.plainLyrics?.slice(0, 2000) ?? (arr[0]?.instrumental ? '[strumentale]' : '') };
  }
  if (!res.ok) return null;
  const j = (await res.json()) as { plainLyrics?: string; instrumental?: boolean };
  return { uri: t.uri, lyrics: j.instrumental ? '[strumentale]' : j.plainLyrics?.slice(0, 2000) ?? '' };
}

const artistTagCache = new Map<string, string>();

/** Top tags from Last.fm (track, then artist fallback). Requires the user's API key. */
export async function fetchTags(t: TrackRef, apiKey: string, signal: AbortSignal): Promise<MetaRow | null> {
  const base = 'https://ws.audioscrobbler.com/2.0/?format=json&autocorrect=1&api_key=' + encodeURIComponent(apiKey);
  const pick = (tags: Array<{ name: string; count: number }> | undefined) =>
    (tags ?? [])
      .filter((x) => x.count >= 10 && x.name.length < 30)
      .slice(0, 8)
      .map((x) => x.name.toLowerCase())
      .join(', ');
  const res = await netFetch(
    `${base}&method=track.gettoptags&artist=${encodeURIComponent(t.artist)}&track=${encodeURIComponent(t.track)}`,
    'tag Last.fm',
    { signal },
  );
  if (res.status === 403 || res.status === 401) throw new Error('Chiave Last.fm non valida');
  let tags = '';
  if (res.ok) {
    const j = (await res.json()) as { toptags?: { tag?: Array<{ name: string; count: number }> } };
    tags = pick(j.toptags?.tag);
  }
  if (!tags) {
    const cached = artistTagCache.get(t.artist);
    if (cached !== undefined) tags = cached;
    else {
      const r2 = await netFetch(`${base}&method=artist.gettoptags&artist=${encodeURIComponent(t.artist)}`, 'tag Last.fm', {
        signal,
      });
      if (r2.ok) {
        const j = (await r2.json()) as { toptags?: { tag?: Array<{ name: string; count: number }> } };
        tags = pick(j.toptags?.tag);
      }
      artistTagCache.set(t.artist, tags);
    }
  }
  return { uri: t.uri, tags };
}

import type { MetaRow } from '../data/schema';
import { netFetch } from './net';
import { ENV_KEYS } from '../lib/store';

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
        valence_audio: c.valence,
        energy_audio: c.energy,
        mood_adj: null,
        danceability: c.danceability,
        tempo: c.tempo,
        acousticness: c.acousticness,
        mood_source: 'reccobeats',
        mood_conf: 1,
      } satisfies MetaRow;
    })
    .filter(Boolean) as MetaRow[];
}

// Registered client-side app (public ID, safe to ship): ~180 req/min instead of ~45.
// Authorization: https://lrclib.net/developers/authorizations/adlfM5TYmaE-g5-OYvl6q90ReuPMly_3GZkaQzYZDFU
const LRCLIB_HEADERS = {
  'Lrclib-App-Id': ENV_KEYS.lrclibAppId || 'adlfM5TYmaE-g5-OYvl6q90ReuPMly_3GZkaQzYZDFU',
  'Lrclib-Client': 'Ascolti/2.0 (https://github.com/Lumingft18/Spotify-Stats)',
};
const norm = (x: string) =>
  x
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Plain lyrics from LRCLIB with ONE request per track (`/api/search` reads LRCLIB's own DB, no slow
 * external lookups). The client identifies itself (higher rate limit) and the job runs sequentially,
 * as LRCLIB's docs require. Returns '' when not found so the track is not retried forever.
 */
export async function fetchLyrics(t: TrackRef, signal: AbortSignal): Promise<MetaRow | null> {
  const qs = new URLSearchParams({ track_name: t.track.replace(/\s*[([].*?[)\]]/g, '').trim() || t.track, artist_name: t.artist });
  const res = await netFetch(`https://lrclib.net/api/search?${qs}`, 'testi', { signal, headers: LRCLIB_HEADERS });
  if (!res.ok) return res.status === 404 ? { uri: t.uri, lyrics: '' } : null;
  const arr = (await res.json()) as Array<{ trackName?: string; artistName?: string; duration?: number; plainLyrics?: string | null; instrumental?: boolean }>;
  const wantArtist = norm(t.artist);
  const wantTrack = norm(t.track);
  const dur = t.duration_ms ? t.duration_ms / 1000 : null;
  const scored = arr
    .filter((a) => a.plainLyrics || a.instrumental)
    .map((a) => {
      let score = 0;
      if (norm(a.artistName ?? '').includes(wantArtist) || wantArtist.includes(norm(a.artistName ?? ''))) score += 2;
      if (norm(a.trackName ?? '') === wantTrack) score += 2;
      if (dur && a.duration && Math.abs(a.duration - dur) <= 3) score += 1;
      return { a, score };
    })
    .sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (!best || best.score < 2) return { uri: t.uri, lyrics: '' };
  return { uri: t.uri, lyrics: best.a.instrumental ? '[strumentale]' : (best.a.plainLyrics ?? '').slice(0, 2000) };
}

/** Artist genres from MusicBrainz (free, no key). Cached per artist; ~1 request/second as MusicBrainz asks. */
const mbArtistCache = new Map<string, string>();
export async function fetchArtistTagsMB(artist: string, signal: AbortSignal): Promise<string> {
  const hit = mbArtistCache.get(artist);
  if (hit !== undefined) return hit;
  const q = encodeURIComponent(`artist:"${artist.replace(/"/g, '')}"`);
  // Through the local server: identifying User-Agent + one paced queue (see server/api.ts).
  const res = await netFetch(`/api/mb/artist?query=${q}`, 'generi MusicBrainz', { signal });
  if (!res.ok) {
    if (res.status === 404) mbArtistCache.set(artist, '');
    if (res.status >= 500 || res.status === 429 || res.status === 503) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return '';
  }
  const j = (await res.json()) as { artists?: Array<{ name: string; score?: number; tags?: Array<{ name: string; count: number }> }> };
  const a = j.artists?.[0];
  const tags =
    a && (a.score ?? 0) >= 90 && norm(a.name) === norm(artist)
      ? (a.tags ?? [])
          .sort((x, y) => y.count - x.count)
          .slice(0, 8)
          .map((x) => x.name.toLowerCase())
          .join(', ')
      : '';
  mbArtistCache.set(artist, tags);
  return tags;
}

const artistTagCache = new Map<string, string>();

/** Top tags from Last.fm (track, then artist fallback). Requires the user's API key. */
export async function fetchTags(t: TrackRef, apiKey: string, signal: AbortSignal): Promise<MetaRow | null> {
  // Through the local server: identifying User-Agent + paced queue (see server/api.ts).
  const base = '/api/lastfm?autocorrect=1&api_key=' + encodeURIComponent(apiKey);
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

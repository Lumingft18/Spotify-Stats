// Pure, environment-agnostic normalization of Spotify streaming-history JSON.
// Supports both the "Extended streaming history" format and the legacy
// "StreamingHistory*.json" (account data) format.

export type PlayKind = 'track' | 'episode' | 'audiobook';

export interface PlayColumns {
  ts_start: string[]; // UTC start, 'YYYY-MM-DD HH:MM:SS'
  ts_local: string[]; // local start (selected time zone)
  ms_played: number[];
  track_uri: (string | null)[];
  track: string[];
  artist: string[];
  album: string[];
  kind: PlayKind[];
  platform: string[];
  conn_country: string[];
  reason_start: string[];
  reason_end: string[];
  shuffle: boolean[];
  skipped: boolean[];
  offline: boolean[];
  incognito: boolean[];
}

export const PLAY_COLUMNS: Array<keyof PlayColumns> = [
  'ts_start',
  'ts_local',
  'ms_played',
  'track_uri',
  'track',
  'artist',
  'album',
  'kind',
  'platform',
  'conn_country',
  'reason_start',
  'reason_end',
  'shuffle',
  'skipped',
  'offline',
  'incognito',
];

export function emptyColumns(): PlayColumns {
  return {
    ts_start: [],
    ts_local: [],
    ms_played: [],
    track_uri: [],
    track: [],
    artist: [],
    album: [],
    kind: [],
    platform: [],
    conn_country: [],
    reason_start: [],
    reason_end: [],
    shuffle: [],
    skipped: [],
    offline: [],
    incognito: [],
  };
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 'True' || v === 1;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pad = (n: number) => (n < 10 ? '0' + n : String(n));

export function fmtUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
}

/** Returns a function converting a UTC epoch (ms) to a local 'YYYY-MM-DD HH:MM:SS' string in `timeZone`.
 *  Offsets are cached per UTC hour, so this stays fast on 100k+ rows. */
export function makeLocalizer(timeZone: string): (epochMs: number) => string {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hourCycle: 'h23' });
  }
  const cache = new Map<number, number>();
  const offsetFor = (epochMs: number): number => {
    const hourKey = Math.floor(epochMs / 3_600_000);
    const hit = cache.get(hourKey);
    if (hit !== undefined) return hit;
    const parts = dtf.formatToParts(new Date(hourKey * 3_600_000));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const off = asUtc - hourKey * 3_600_000;
    cache.set(hourKey, off);
    return off;
  };
  return (epochMs: number) => fmtUtc(new Date(epochMs + offsetFor(epochMs)));
}

export function normalizePlatform(p: string): string {
  const s = p.toLowerCase();
  if (!s) return 'Sconosciuto';
  if (s.includes('ios') || s.includes('iphone') || s.includes('ipad')) return 'iOS';
  if (s.includes('android')) return 'Android';
  if (s.includes('web')) return 'Web';
  if (s.includes('windows') || s.includes('os x') || s.includes('osx') || s.includes('mac') || s.includes('linux'))
    return 'Desktop';
  if (
    s.includes('cast') ||
    s.includes('sonos') ||
    s.includes('partner') ||
    s.includes('speaker') ||
    s.includes('tv') ||
    s.includes('playstation') ||
    s.includes('ps4') ||
    s.includes('ps5') ||
    s.includes('xbox') ||
    s.includes('car')
  )
    return 'Altri dispositivi';
  return 'Altro';
}

const REASON_MAP: Record<string, string> = {
  fwdbtn: 'avanti',
  backbtn: 'indietro',
  trackdone: 'fine brano',
  clickrow: 'click',
  playbtn: 'play',
  endplay: 'stop',
  remote: 'remoto',
  appload: 'avvio app',
  logout: 'logout',
  trackerror: 'errore',
  unexpected_exit: 'uscita',
  unexpected_exit_while_paused: 'uscita',
};
export const normalizeReason = (r: string) => (r ? REASON_MAP[r] ?? r : 'sconosciuto');

function parseTs(v: unknown): number {
  const s = str(v);
  if (!s) return NaN;
  // Extended: 2023-07-03T19:09:18Z ; legacy: "2023-01-01 12:34" (UTC)
  if (s.includes('T')) return Date.parse(s);
  return Date.parse(s.replace(' ', 'T') + (s.length <= 16 ? ':00Z' : 'Z'));
}

export interface NormalizeStats {
  rows: number;
  duplicates: number;
  invalid: number;
}

/** Appends normalized rows from one parsed JSON file into `cols`. `seen` is used for cross-file de-duplication. */
export function appendRecords(
  data: unknown,
  cols: PlayColumns,
  localize: (epochMs: number) => string,
  seen: Set<string>,
  stats: NormalizeStats,
  lookup?: Map<string, string>,
): void {
  const arr: Raw[] = Array.isArray(data) ? (data as Raw[]) : data && typeof data === 'object' ? [data as Raw] : [];
  for (const r of arr) {
    const tsEnd = parseTs(r.ts ?? r.endTime);
    if (!Number.isFinite(tsEnd)) {
      stats.invalid++;
      continue;
    }
    const ms = num(r.ms_played ?? r.msPlayed);
    const trackName = str(r.master_metadata_track_name ?? r.trackName);
    const episodeName = str(r.episode_name);
    const audiobook = str(r.audiobook_title);
    let kind: PlayKind;
    if (trackName) kind = 'track';
    else if (episodeName) kind = 'episode';
    else if (audiobook) kind = 'audiobook';
    else {
      stats.invalid++;
      continue;
    }
    let uri = str(r.spotify_track_uri ?? r.spotify_episode_uri ?? r.audiobook_chapter_uri) || null;
    if (!uri && kind === 'track' && lookup) {
      // Legacy "account data" history has no URIs: recover them from library/playlists when possible.
      uri = lookup.get(`${trackName.toLowerCase()}|${str(r.master_metadata_album_artist_name ?? r.artistName).toLowerCase()}`) ?? null;
    }
    const key = `${tsEnd}|${uri ?? trackName}|${ms}`;
    if (seen.has(key)) {
      stats.duplicates++;
      continue;
    }
    seen.add(key);

    // Start time: prefer offline_timestamp when coherent (seconds or ms), else ts - ms_played.
    let start = tsEnd - ms;
    let off = num(r.offline_timestamp);
    if (off > 0) {
      if (off > 2e10) off = off / 1000;
      const offMs = off * 1000;
      if (off > 1e9 && Math.abs(offMs - start) < 86_400_000) start = offMs;
    }

    cols.ts_start.push(fmtUtc(new Date(start)));
    cols.ts_local.push(localize(start));
    cols.ms_played.push(ms);
    cols.track_uri.push(uri);
    if (kind === 'track') {
      cols.track.push(trackName);
      cols.artist.push(str(r.master_metadata_album_artist_name ?? r.artistName) || 'Sconosciuto');
      cols.album.push(str(r.master_metadata_album_album_name ?? r.albumName));
    } else if (kind === 'episode') {
      cols.track.push(episodeName);
      cols.artist.push(str(r.episode_show_name) || 'Podcast');
      cols.album.push(str(r.episode_show_name));
    } else {
      cols.track.push(str(r.audiobook_chapter_title) || audiobook);
      cols.artist.push(audiobook);
      cols.album.push(audiobook);
    }
    cols.kind.push(kind);
    cols.platform.push(normalizePlatform(str(r.platform)));
    cols.conn_country.push(str(r.conn_country) || 'ZZ');
    const rs = str(r.reason_start);
    const re = str(r.reason_end);
    cols.reason_start.push(normalizeReason(rs));
    cols.reason_end.push(normalizeReason(re));
    cols.shuffle.push(bool(r.shuffle));
    // Explicit flag when present; otherwise infer: forward-button end, or short non-complete play.
    const explicit = r.skipped;
    const hasExplicit = explicit === true || explicit === false || explicit === 'true' || explicit === 'false';
    const inferred = re === 'fwdbtn' || (re !== '' && re !== 'trackdone' && ms < 30_000);
    cols.skipped.push(hasExplicit ? bool(explicit) || re === 'fwdbtn' : inferred);
    cols.offline.push(bool(r.offline));
    cols.incognito.push(bool(r.incognito_mode));
    stats.rows++;
  }
}

/** File names worth parsing inside a Spotify export ZIP. */
export function isHistoryFile(name: string): boolean {
  return historyKind(name) !== null;
}

/** 'extended' = full lifetime history (Streaming_History_Audio_*), 'legacy' = last-year history from the account package. */
export function historyKind(name: string): 'extended' | 'legacy' | null {
  const base = name.split('/').pop() ?? name;
  if (!base.toLowerCase().endsWith('.json') || base.startsWith('._') || name.includes('__MACOSX')) return null;
  if (/Video|podcast/i.test(base)) return null;
  if (/Streaming_History_Audio|endsong/i.test(base)) return 'extended';
  if (/^StreamingHistory(_music)?\d*_?\d*\.json$/i.test(base)) return 'legacy';
  return null;
}

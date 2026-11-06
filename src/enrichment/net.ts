import { getApp } from '../lib/store';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * Per-host pacing: minimum gap between request STARTS, shared by every caller (any concurrency, retries included),
 * so a host never sees more than its documented rate. Concurrency then only hides latency, it can't add load.
 *  (MusicBrainz goes through the local server, which paces it: /api/mb)
 *  - lrclib.net: registered client ≈ 180/minute → 340 ms
 *  - ws.audioscrobbler.com (Last.fm): 5/second averaged over 5 minutes → 250 ms (4/s)
 */
const MIN_GAP_MS: Record<string, number> = {
  'lrclib.net': 340,
  'ws.audioscrobbler.com': 250,
};
const nextSlot = new Map<string, number>();

async function waitTurn(host: string, signal?: AbortSignal | null) {
  const gap = MIN_GAP_MS[host];
  if (!gap) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + gap);
  if (at > now) await sleep(at - now, signal ?? undefined);
}

/** fetch() wrapper: paces each host, logs every outbound host (shown in Settings → Connessioni) and retries 429/5xx with backoff. */
export async function netFetch(url: string, purpose: string, init: RequestInit = {}, retries = 3): Promise<Response> {
  const local = url.startsWith('/api/mb/');
  const host = local ? 'musicbrainz.org' : new URL(url).host;
  getApp().logNet(local ? 'musicbrainz.org (via server locale)' : host, purpose);
  let attempt = 0;
  for (;;) {
    if (!local) await waitTurn(host, init.signal);
    const res = await fetch(url, init);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      // Honor Retry-After (+ up to 30% jitter, as LRCLIB/MusicBrainz ask), else exponential backoff.
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 * (1 + Math.random() * 0.3) : 800 * 2 ** attempt + Math.random() * 300;
      attempt++;
      await sleep(Math.min(wait, 65_000), init.signal ?? undefined);
      continue;
    }
    return res;
  }
}

export { sleep };

import { getApp } from '../lib/store';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/** fetch() wrapper: logs every outbound host (shown in Settings → Connessioni) and retries 429/5xx with backoff. */
export async function netFetch(url: string, purpose: string, init: RequestInit = {}, retries = 3): Promise<Response> {
  const host = new URL(url).host;
  getApp().logNet(host, purpose);
  let attempt = 0;
  for (;;) {
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

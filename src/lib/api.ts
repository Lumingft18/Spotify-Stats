// Thin client for the local API (server/api.ts). Same origin, so no CORS and no keys involved.
import { pack, unpack } from './pack';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function check(r: Response): Promise<Response> {
  if (r.ok) return r;
  let msg = `HTTP ${r.status}`;
  try {
    const j = (await r.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch {
    /* not JSON */
  }
  throw new ApiError(r.status, msg);
}

export async function apiJson<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await (await check(r)).json()) as T;
}

/** Returns the raw bytes, or null on 404. */
export async function apiBytes(path: string, method = 'GET', body?: Uint8Array | string): Promise<Uint8Array | null> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' },
    body: body as BodyInit | undefined,
  });
  if (r.status === 404 || r.status === 204) return null;
  return new Uint8Array(await (await check(r)).arrayBuffer());
}

export const apiPacked = async <T>(path: string, method: string, value: unknown): Promise<T | null> => {
  const b = await apiBytes(path, method, pack(value));
  return b && b.length ? (unpack<T>(b) as T) : null;
};

/** True when the local database server answers (always the case with `npm run dev` / the launcher). */
export async function apiAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

const IMG_HOSTS = /^https:\/\/(i\.scdn\.co|mosaic\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com)\//i;

/** Cover URLs are served through the local database (downloaded once, then offline). Other URLs pass through. */
export function coverSrc(url: string | null | undefined): string | null | undefined {
  if (!url || !IMG_HOSTS.test(url)) return url;
  return `/api/img?u=${encodeURIComponent(url)}`;
}

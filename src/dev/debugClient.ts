// Browser half of the dev-only debug bridge (see debugBridge.ts). Loaded only by the Vite dev server.
import { query } from '../data/db';
import { idb, type StoreName } from '../lib/idb';
import { useApp } from '../lib/store';

const SECRET = /key|token|secret|password/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.length > 50 ? [...v.slice(0, 50).map((x) => redact(x, depth + 1)), `… +${v.length - 50}`] : v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => typeof x !== 'function')
      .map(([k, x]) => [k, SECRET.test(k) && typeof x === 'string' ? (x ? '[redatto]' : '') : redact(x, depth + 1)]),
  );
}

function truncate(v: unknown, max = 200_000): unknown {
  const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? `[binario ${(x as ArrayBuffer).byteLength} byte]` : x));
  if (s == null) return v;
  return s.length > max ? { truncated: true, bytes: s.length, preview: s.slice(0, max) } : JSON.parse(s);
}

const READ_ONLY = /^\s*(select|with|describe|summarize|show|pragma|explain|from)\b/i;

async function handle(op: string, payload: Record<string, unknown> | null): Promise<unknown> {
  switch (op) {
    case 'ping':
      return { ok: true, url: location.href, title: document.title, status: useApp.getState().status, visible: document.visibilityState };
    case 'state': {
      const { profile, ...rest } = useApp.getState();
      return truncate({
        url: location.href,
        ...(redact(rest) as object),
        profile: profile ? { displayName: profile.displayName, username: profile.username, country: profile.country, files: profile.files?.length } : null,
      });
    }
    case 'sql': {
      const sql = String(payload?.sql ?? '');
      if (!READ_ONLY.test(sql)) throw new Error('Solo query di lettura (SELECT/WITH/DESCRIBE/SUMMARIZE/SHOW/PRAGMA/EXPLAIN).');
      const rows = await query(sql, (payload?.params as unknown[]) ?? []);
      return truncate({ count: rows.length, rows: rows.slice(0, 5000) });
    }
    case 'idb': {
      const store = (payload?.store as StoreName) ?? 'kv';
      const key = payload?.key as string | null;
      if (!key) return (await idb.getAll<unknown>(store)).map(([k, v]) => ({ key: k, type: Array.isArray(v) ? `array(${v.length})` : typeof v }));
      return truncate(redact(await idb.get(key, store)));
    }
    case 'navigate': {
      const hash = String(payload?.hash ?? '');
      if (!hash.startsWith('#')) throw new Error('hash deve iniziare con #');
      location.hash = hash;
      return { ok: true, url: location.href };
    }
    default:
      throw new Error(`op sconosciuta: ${op}`);
  }
}

export function startDebugClient() {
  const hot = import.meta.hot;
  if (!hot) return;
  hot.on('ascolti:debug-req', async ({ id, op, payload }: { id: string; op: string; payload: Record<string, unknown> | null }) => {
    try {
      hot.send('ascolti:debug-res', { id, ok: true, data: await handle(op, payload) });
    } catch (e) {
      hot.send('ascolti:debug-res', { id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  const fmt = (a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
  const push = (level: string, args: unknown[]) =>
    hot.send('ascolti:debug-log', { at: new Date().toISOString(), level, url: location.hash, msg: args.map(fmt).join(' ').slice(0, 4000) });
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      orig(...args);
    };
  }
  addEventListener('error', (e) => push('uncaught', [e.error ?? e.message]));
  addEventListener('unhandledrejection', (e) => push('unhandledrejection', [e.reason]));
}

// DuckDB-WASM engine (runs in its own Web Worker) + persistence in IndexedDB as Arrow IPC.
import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { tableFromArrays, tableToIPC, tableFromIPC, Table, Utf8, Float64, Int32, Bool, vectorFromArray, makeTable } from 'apache-arrow';
import { idb } from '../lib/idb';
import { PLAY_COLUMNS, type PlayColumns } from './normalize';
import { BUILD_SQL, META_SQL, META_COLUMNS, filterViewSql, type MetaRow } from './schema';

let dbP: Promise<duckdb.AsyncDuckDB> | null = null;
let connP: Promise<duckdb.AsyncDuckDBConnection> | null = null;
// Serialize all statements: DuckDB connections are not re-entrant.
let chain: Promise<unknown> = Promise.resolve();

function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (!dbP) {
    dbP = (async () => {
      const bundle = await duckdb.selectBundle({
        mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
        eh: { mainModule: ehWasm, mainWorker: ehWorker },
      });
      const worker = new Worker(bundle.mainWorker!);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      return db;
    })();
  }
  return dbP;
}

function getConn() {
  if (!connP) connP = getDb().then((db) => db.connect());
  return connP;
}

function serial<T>(fn: (c: duckdb.AsyncDuckDBConnection) => Promise<T>): Promise<T> {
  const run = chain.then(async () => fn(await getConn()));
  chain = run.catch(() => undefined);
  return run;
}

/** Converts Arrow values to plain JS (BigInt → number, Date stays number ms). */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && 'toJSON' in (v as object) && !(v instanceof Date)) {
    return (v as { toJSON(): unknown }).toJSON();
  }
  return v;
}

function rowsOf<T>(t: Table): T[] {
  const fields = t.schema.fields.map((f) => f.name);
  const out: T[] = new Array(t.numRows);
  const cols = fields.map((f) => t.getChild(f)!);
  for (let i = 0; i < t.numRows; i++) {
    const o: Record<string, unknown> = {};
    for (let j = 0; j < fields.length; j++) o[fields[j]] = plain(cols[j].get(i));
    out[i] = o as T;
  }
  return out;
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return serial(async (c) => {
    if (!params.length) return rowsOf<T>(await c.query(sql));
    const stmt = await c.prepare(sql);
    try {
      return rowsOf<T>(await stmt.query(...params));
    } finally {
      await stmt.close();
    }
  });
}

export async function exec(sql: string): Promise<void> {
  await serial((c) => c.query(sql));
}

// ---------- ingestion ----------

function playsTable(cols: PlayColumns): Table {
  return tableFromArrays({
    ts_start: vectorFromArray(cols.ts_start, new Utf8()),
    ts_local: vectorFromArray(cols.ts_local, new Utf8()),
    ms_played: Float64Array.from(cols.ms_played),
    track_uri: vectorFromArray(cols.track_uri, new Utf8()),
    track: vectorFromArray(cols.track, new Utf8()),
    artist: vectorFromArray(cols.artist, new Utf8()),
    album: vectorFromArray(cols.album, new Utf8()),
    kind: vectorFromArray(cols.kind, new Utf8()),
    platform: vectorFromArray(cols.platform, new Utf8()),
    conn_country: vectorFromArray(cols.conn_country, new Utf8()),
    reason_start: vectorFromArray(cols.reason_start, new Utf8()),
    reason_end: vectorFromArray(cols.reason_end, new Utf8()),
    shuffle: vectorFromArray(cols.shuffle, new Bool()),
    skipped: vectorFromArray(cols.skipped, new Bool()),
    offline: vectorFromArray(cols.offline, new Bool()),
    incognito: vectorFromArray(cols.incognito, new Bool()),
  } as never) as unknown as Table;
}

async function insertArrow(table: Table, name: string) {
  await serial(async (c) => {
    await c.query(`DROP TABLE IF EXISTS ${name}`);
    await c.insertArrowTable(table, { name, create: true });
  });
}

async function buildDerived() {
  await exec(BUILD_SQL);
  await exec(META_SQL);
  await exec(`CREATE TABLE IF NOT EXISTS clusters (id INTEGER, label VARCHAR)`);
  await exec(filterViewSql(null, null));
}

const IPC_KEY = 'plays_ipc';

/** Loads normalized columns, builds derived tables and persists raw data for instant reopen. */
export async function loadPlays(cols: PlayColumns): Promise<void> {
  if (PLAY_COLUMNS.some((k) => !Array.isArray(cols[k]))) throw new Error('Colonne non valide');
  const t = playsTable(cols);
  await insertArrow(t, 'plays_raw');
  await buildDerived();
  await idb.set(IPC_KEY, tableToIPC(t, 'stream'));
}

/** Restores the previous session. Returns false when nothing is stored. */
export async function restore(): Promise<boolean> {
  const ipc = await idb.get<Uint8Array>(IPC_KEY);
  if (!ipc) return false;
  await insertArrow(tableFromIPC(ipc), 'plays_raw');
  await buildDerived();
  const metaRows = await idb.get<MetaRow[]>('meta_rows');
  if (metaRows?.length) {
    for (let i = 0; i < metaRows.length; i += 3000) await upsertMeta(metaRows.slice(i, i + 3000), false);
  }
  const clusters = await idb.get<Array<{ id: number; label: string }>>('clusters');
  if (clusters?.length) await setClusters(clusters, false);
  return true;
}

export async function setFilter(from: string | null, to: string | null) {
  await exec(filterViewSql(from, to));
}

// ---------- meta (enrichment) ----------

const NUMERIC_META = new Set(['valence', 'energy', 'danceability', 'tempo', 'acousticness', 'mood_conf', 'x', 'y', 'valence_audio', 'energy_audio', 'valence_lyrics']);

let metaPersistTimer: ReturnType<typeof setTimeout> | null = null;
let tmpSeq = 0;

/** Upserts partial meta rows (only provided keys are updated; others are preserved). */
export async function upsertMeta(rows: MetaRow[], persist = true): Promise<void> {
  if (!rows.length) return;
  const keys = META_COLUMNS.filter((k) => k !== 'uri' && rows.some((r) => k in r));
  const data: Record<string, unknown> = { uri: vectorFromArray(rows.map((r) => r.uri), new Utf8()) };
  for (const k of keys) {
    const vals = rows.map((r) => (k in r ? r[k as keyof MetaRow] ?? null : null));
    if (k === 'cluster') data[k] = vectorFromArray(vals as (number | null)[], new Int32());
    else if (NUMERIC_META.has(k)) data[k] = vectorFromArray(vals as (number | null)[], new Float64());
    else data[k] = vectorFromArray(vals.map((v) => (v == null ? null : String(v))), new Utf8());
  }
  // has_<k> flags tell us whether the row actually provided the key (null-able updates are allowed).
  for (const k of keys) data[`has_${k}`] = vectorFromArray(rows.map((r) => k in r), new Bool());
  // One atomic serialized block with a unique temp name: concurrent enrichment steps must not share 'meta_in'.
  const tmp = `meta_in_${++tmpSeq}`;
  const sets = keys.map((k) => `${k} = CASE WHEN i.has_${k} THEN i.${k} ELSE m.${k} END`).join(', ');
  await serial(async (c) => {
    await c.insertArrowTable(tableFromArrays(data as never) as unknown as Table, { name: tmp, create: true });
    try {
      await c.query(`INSERT INTO meta (uri) SELECT DISTINCT i.uri FROM ${tmp} i WHERE i.uri NOT IN (SELECT uri FROM meta)`);
      if (keys.length) await c.query(`UPDATE meta m SET ${sets} FROM ${tmp} i WHERE m.uri = i.uri`);
    } finally {
      await c.query(`DROP TABLE IF EXISTS ${tmp}`);
    }
  });
  if (!persist) return;
  if (metaPersistTimer) clearTimeout(metaPersistTimer);
  metaPersistTimer = setTimeout(() => void persistMeta(), 1500);
}

export async function persistMeta() {
  // Stored as plain rows (structured clone) — robust across engine versions.
  const rows = await query<MetaRow>(`SELECT * FROM meta`);
  const clean = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v != null)) as MetaRow);
  await idb.set('meta_rows', clean);
}

export async function setClusters(list: Array<{ id: number; label: string }>, persist = true) {
  const t = makeTable({
    id: Int32Array.from(list.map((c) => c.id)),
  });
  const withLabels = tableFromArrays({
    id: t.getChild('id')!,
    label: vectorFromArray(list.map((c) => c.label), new Utf8()),
  } as never) as unknown as Table;
  await insertArrow(withLabels, 'clusters');
  if (persist) await idb.set('clusters', list);
}

export async function wipeAll() {
  await idb.wipe();
  try {
    await exec(`DROP VIEW IF EXISTS p; DROP TABLE IF EXISTS plays; DROP TABLE IF EXISTS plays_raw; DROP TABLE IF EXISTS tracks;
      DROP TABLE IF EXISTS plays_seq; DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS clusters;`);
  } catch {
    /* ignore */
  }
}

/** Loads normalized columns into an arbitrary scratch table (used for friend comparisons; not persisted). */
export async function loadScratchPlays(cols: PlayColumns, name: string): Promise<void> {
  if (!/^[a-z_]+$/.test(name)) throw new Error('nome tabella non valido');
  await insertArrow(playsTable(cols), name);
}

/** Warm the engine early (downloads wasm while the user reads the landing page). */
export function prewarm() {
  void getConn();
}

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { appendRecords, emptyColumns, isHistoryFile, makeLocalizer, type PlayColumns } from '../src/data/normalize';
import { BUILD_SQL, META_SQL, filterViewSql } from '../src/data/schema';

export interface NodeEngine {
  conn: DuckDBConnection;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}

export async function createNodeEngine(): Promise<NodeEngine> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  return {
    conn,
    async query(sql, params) {
      const r = params?.length
        ? await conn.runAndReadAll(sql, params as never)
        : await conn.runAndReadAll(sql);
      // Mirror the browser engine: BIGINT → number, other DuckDB values → JSON-ish.
      return r.getRowObjectsJS().map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.getTime() : v && typeof v === 'object' && 'toString' in v ? String(v) : v,
          ]),
        ),
      ) as never;
    },
    async exec(sql) {
      await conn.run(sql);
    },
  };
}

export function columnsFromZip(path: string): PlayColumns {
  const files = unzipSync(new Uint8Array(readFileSync(path)));
  const cols = emptyColumns();
  const seen = new Set<string>();
  const stats = { rows: 0, duplicates: 0, invalid: 0 };
  const loc = makeLocalizer('Europe/Rome');
  for (const [name, bytes] of Object.entries(files)) {
    if (!isHistoryFile(name)) continue;
    appendRecords(JSON.parse(strFromU8(bytes)), cols, loc, seen, stats);
  }
  return cols;
}

export async function loadColumns(e: NodeEngine, cols: PlayColumns) {
  await e.exec(`CREATE OR REPLACE TABLE plays_raw (ts_start VARCHAR, ts_local VARCHAR, ms_played BIGINT, track_uri VARCHAR,
    track VARCHAR, artist VARCHAR, album VARCHAR, kind VARCHAR, platform VARCHAR, conn_country VARCHAR,
    reason_start VARCHAR, reason_end VARCHAR, shuffle BOOLEAN, skipped BOOLEAN, offline BOOLEAN, incognito BOOLEAN)`);
  const a = await e.conn.createAppender('plays_raw');
  for (let i = 0; i < cols.ts_start.length; i++) {
    a.appendVarchar(cols.ts_start[i]);
    a.appendVarchar(cols.ts_local[i]);
    a.appendBigInt(BigInt(Math.round(cols.ms_played[i])));
    if (cols.track_uri[i] == null) a.appendNull(); else a.appendVarchar(cols.track_uri[i]!);
    a.appendVarchar(cols.track[i]);
    a.appendVarchar(cols.artist[i]);
    a.appendVarchar(cols.album[i]);
    a.appendVarchar(cols.kind[i]);
    a.appendVarchar(cols.platform[i]);
    a.appendVarchar(cols.conn_country[i]);
    a.appendVarchar(cols.reason_start[i]);
    a.appendVarchar(cols.reason_end[i]);
    a.appendBoolean(cols.shuffle[i]);
    a.appendBoolean(cols.skipped[i]);
    a.appendBoolean(cols.offline[i]);
    a.appendBoolean(cols.incognito[i]);
    a.endRow();
  }
  a.closeSync();
  await e.exec(BUILD_SQL);
  await e.exec(META_SQL);
  await e.exec(`CREATE TABLE IF NOT EXISTS clusters (id INTEGER, label VARCHAR)`);
  await e.exec(filterViewSql(null, null));
}

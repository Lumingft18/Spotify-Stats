// Local SQLite database (node:sqlite, no native deps) shared by every analysis and every person using this install.
//
// - analyses / analysis_kv: one row per named analysis; its personal data (history, enrichment, chats…) as opaque blobs.
// - catalog / catalog_tried: PUBLIC per-track data (cover URL, audio features, lyrics, tags) reused across analyses.
// - embeddings: text-embedding vectors keyed by (model, sha256 of the document) — paid API calls are never repeated.
// - ai_cache: per-track AI outputs (mood estimate, lyric valence) keyed by (kind, model, prompt hash, uri):
//   the same song is never paid for twice. Always labelled as estimates, never merged into `catalog`.
// - images: cover images downloaded once and served locally.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export interface AnalysisRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  opened_at: number
  history_kind: string | null
  rows: number | null
  first_day: string | null
  last_day: string | null
  display_name: string | null
  /** When every enrichment step last finished (null = never, or new data imported since). */
  enriched_at: number | null
  bytes: number
}

export const CATALOG_KEYS = ['cover', 'valence', 'energy', 'danceability', 'tempo', 'acousticness', 'mood_source', 'mood_conf', 'lyrics', 'tags'] as const
export type CatalogKey = (typeof CATALOG_KEYS)[number]
export type CatalogRow = { uri: string } & Partial<Record<CatalogKey, string | number | null>>

const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS analyses (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  opened_at    INTEGER NOT NULL,
  history_kind TEXT,
  rows         INTEGER,
  first_day    TEXT,
  last_day     TEXT,
  display_name TEXT
);
CREATE TABLE IF NOT EXISTS analysis_kv (
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  store       TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       BLOB NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (analysis_id, store, key)
);
CREATE TABLE IF NOT EXISTS catalog (
  uri          TEXT PRIMARY KEY,
  cover        TEXT,
  valence      REAL,
  energy       REAL,
  danceability REAL,
  tempo        REAL,
  acousticness REAL,
  mood_source  TEXT,
  mood_conf    REAL,
  lyrics       TEXT,
  tags         TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_tried (
  uri  TEXT NOT NULL,
  step TEXT NOT NULL,
  at   INTEGER NOT NULL,
  PRIMARY KEY (uri, step)
);
CREATE TABLE IF NOT EXISTS embeddings (
  model TEXT NOT NULL,
  hash  TEXT NOT NULL,
  vec   BLOB NOT NULL,
  PRIMARY KEY (model, hash)
);
CREATE TABLE IF NOT EXISTS ai_cache (
  kind    TEXT NOT NULL,
  model   TEXT NOT NULL,
  version TEXT NOT NULL,
  uri     TEXT NOT NULL,
  value   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (kind, model, version, uri)
);
CREATE TABLE IF NOT EXISTS images (
  url        TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  fetched_at INTEGER NOT NULL
);
`

const META_FIELDS = ['history_kind', 'rows', 'first_day', 'last_day', 'display_name', 'enriched_at'] as const
type AnalysisMeta = Partial<Pick<AnalysisRow, (typeof META_FIELDS)[number] | 'name'>>

const chunks = <T,>(xs: T[], n = 500): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export class Store {
  readonly db: DatabaseSync

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)
    // Columns added after the first release.
    const cols = this.db.prepare(`PRAGMA table_info(analyses)`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'enriched_at')) this.db.exec(`ALTER TABLE analyses ADD COLUMN enriched_at INTEGER`)
  }

  close() {
    this.db.close()
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- analyses ----------

  listAnalyses(): AnalysisRow[] {
    return this.db
      .prepare(
        `SELECT a.*, coalesce((SELECT sum(length(value)) FROM analysis_kv k WHERE k.analysis_id = a.id), 0) AS bytes
         FROM analyses a ORDER BY a.opened_at DESC`,
      )
      .all() as unknown as AnalysisRow[]
  }

  getAnalysis(id: string): AnalysisRow | null {
    return (
      (this.db
        .prepare(
          `SELECT a.*, coalesce((SELECT sum(length(value)) FROM analysis_kv k WHERE k.analysis_id = a.id), 0) AS bytes
           FROM analyses a WHERE a.id = ?`,
        )
        .get(id) as unknown as AnalysisRow | undefined) ?? null
    )
  }

  createAnalysis(name: string): AnalysisRow {
    const clean = name.trim().slice(0, 120)
    if (!clean) throw new HttpError(400, 'Serve un nome per l’analisi')
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`INSERT INTO analyses (id, name, created_at, updated_at, opened_at) VALUES (?, ?, ?, ?, ?)`).run(id, clean, now, now, now)
    return this.getAnalysis(id)!
  }

  updateAnalysis(id: string, patch: AnalysisMeta & { opened?: boolean }): AnalysisRow {
    if (!this.getAnalysis(id)) throw new HttpError(404, 'Analisi non trovata')
    const sets: string[] = []
    const vals: Array<string | number | null> = []
    if (typeof patch.name === 'string') {
      const n = patch.name.trim().slice(0, 120)
      if (!n) throw new HttpError(400, 'Il nome non può essere vuoto')
      sets.push('name = ?')
      vals.push(n)
    }
    for (const k of META_FIELDS) {
      if (k in patch) {
        sets.push(`${k} = ?`)
        vals.push((patch[k] as string | number | null | undefined) ?? null)
      }
    }
    const now = Date.now()
    if (patch.opened) {
      sets.push('opened_at = ?')
      vals.push(now)
    }
    sets.push('updated_at = ?')
    vals.push(now)
    this.db.prepare(`UPDATE analyses SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    return this.getAnalysis(id)!
  }

  deleteAnalysis(id: string) {
    this.db.prepare(`DELETE FROM analyses WHERE id = ?`).run(id)
  }

  // ---------- per-analysis key/value ----------

  private assertAnalysis(id: string) {
    if (!this.db.prepare(`SELECT 1 FROM analyses WHERE id = ?`).get(id)) throw new HttpError(404, 'Analisi non trovata')
  }

  kvGet(id: string, store: string, key: string): Uint8Array | null {
    const r = this.db.prepare(`SELECT value FROM analysis_kv WHERE analysis_id = ? AND store = ? AND key = ?`).get(id, store, key) as
      | { value: Uint8Array }
      | undefined
    return r?.value ?? null
  }

  kvSetMany(id: string, entries: Array<{ store: string; key: string; value: Uint8Array | null }>) {
    this.assertAnalysis(id)
    const now = Date.now()
    const put = this.db.prepare(
      `INSERT INTO analysis_kv (analysis_id, store, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (analysis_id, store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    const del = this.db.prepare(`DELETE FROM analysis_kv WHERE analysis_id = ? AND store = ? AND key = ?`)
    this.tx(() => {
      for (const e of entries) {
        if (e.value) put.run(id, e.store, e.key, e.value, now)
        else del.run(id, e.store, e.key)
      }
      this.db.prepare(`UPDATE analyses SET updated_at = ? WHERE id = ?`).run(now, id)
    })
  }

  kvList(id: string, store?: string): Array<{ store: string; key: string; bytes: number; updated_at: number }> {
    const sql = `SELECT store, key, length(value) AS bytes, updated_at FROM analysis_kv WHERE analysis_id = ?${store ? ' AND store = ?' : ''} ORDER BY store, key`
    return this.db.prepare(sql).all(...(store ? [id, store] : [id])) as never
  }

  kvClear(id: string, store: string) {
    this.db.prepare(`DELETE FROM analysis_kv WHERE analysis_id = ? AND store = ?`).run(id, store)
  }

  // ---------- shared catalog ----------

  catalogGet(uris: string[]): CatalogRow[] {
    const out: CatalogRow[] = []
    for (const part of chunks([...new Set(uris)])) {
      const rows = this.db
        .prepare(`SELECT uri, ${CATALOG_KEYS.join(', ')} FROM catalog WHERE uri IN (${part.map(() => '?').join(',')})`)
        .all(...part) as Array<Record<string, unknown>>
      for (const r of rows) {
        const row: CatalogRow = { uri: String(r.uri) }
        for (const k of CATALOG_KEYS) if (r[k] != null) row[k] = r[k] as string | number
        out.push(row)
      }
    }
    return out
  }

  /** Merges: only non-null provided fields overwrite. */
  catalogPut(rows: CatalogRow[]): number {
    const now = Date.now()
    let n = 0
    this.tx(() => {
      for (const r of rows) {
        if (typeof r.uri !== 'string' || !r.uri.startsWith('spotify:track:')) continue
        const keys = CATALOG_KEYS.filter((k) => r[k] != null)
        if (!keys.length) continue
        this.db
          .prepare(
            `INSERT INTO catalog (uri, ${keys.join(', ')}, updated_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
             ON CONFLICT (uri) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
          )
          .run(r.uri, ...keys.map((k) => r[k] as string | number), now)
        n++
      }
    })
    return n
  }

  catalogStats() {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n)
    return {
      tracks: one(`SELECT count(*) AS n FROM catalog`),
      covers: one(`SELECT count(*) AS n FROM catalog WHERE cover IS NOT NULL AND cover <> ''`),
      lyrics: one(`SELECT count(*) AS n FROM catalog WHERE lyrics IS NOT NULL AND lyrics <> ''`),
      audio: one(`SELECT count(*) AS n FROM catalog WHERE valence IS NOT NULL`),
      tags: one(`SELECT count(*) AS n FROM catalog WHERE tags IS NOT NULL AND tags <> ''`),
      embeddings: one(`SELECT count(*) AS n FROM embeddings`),
      ai: one(`SELECT count(*) AS n FROM ai_cache`),
      images: one(`SELECT count(*) AS n FROM images`),
      imageBytes: one(`SELECT coalesce(sum(length(data)), 0) AS n FROM images`),
    }
  }

  catalogClear() {
    this.db.exec(`DELETE FROM catalog; DELETE FROM catalog_tried; DELETE FROM embeddings; DELETE FROM images; DELETE FROM ai_cache;`)
  }

  triedGet(step: string, uris: string[]): string[] {
    const out: string[] = []
    for (const part of chunks([...new Set(uris)])) {
      const rows = this.db
        .prepare(`SELECT uri FROM catalog_tried WHERE step = ? AND uri IN (${part.map(() => '?').join(',')})`)
        .all(step, ...part) as Array<{ uri: string }>
      for (const r of rows) out.push(r.uri)
    }
    return out
  }

  triedClear() {
    this.db.exec(`DELETE FROM catalog_tried`)
  }

  triedPut(step: string, uris: string[]) {
    const now = Date.now()
    const st = this.db.prepare(`INSERT OR IGNORE INTO catalog_tried (uri, step, at) VALUES (?, ?, ?)`)
    this.tx(() => {
      for (const u of uris) if (typeof u === 'string' && u) st.run(u, step, now)
    })
  }

  // ---------- embeddings ----------

  embGet(model: string, hashes: string[]): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>()
    for (const part of chunks([...new Set(hashes)])) {
      const rows = this.db
        .prepare(`SELECT hash, vec FROM embeddings WHERE model = ? AND hash IN (${part.map(() => '?').join(',')})`)
        .all(model, ...part) as Array<{ hash: string; vec: Uint8Array }>
      for (const r of rows) out.set(r.hash, r.vec)
    }
    return out
  }

  embPut(model: string, items: Array<{ hash: string; vec: Uint8Array }>) {
    const st = this.db.prepare(`INSERT OR REPLACE INTO embeddings (model, hash, vec) VALUES (?, ?, ?)`)
    this.tx(() => {
      for (const it of items) st.run(model, it.hash, it.vec)
    })
  }

  // ---------- AI outputs ----------

  aiGet(kind: string, model: string, version: string, uris: string[]): Array<{ uri: string; value: unknown }> {
    const out: Array<{ uri: string; value: unknown }> = []
    for (const part of chunks([...new Set(uris)])) {
      const rows = this.db
        .prepare(`SELECT uri, value FROM ai_cache WHERE kind = ? AND model = ? AND version = ? AND uri IN (${part.map(() => '?').join(',')})`)
        .all(kind, model, version, ...part) as Array<{ uri: string; value: string }>
      for (const r of rows) out.push({ uri: r.uri, value: JSON.parse(r.value) })
    }
    return out
  }

  aiPut(kind: string, model: string, version: string, items: Array<{ uri: string; value: unknown }>) {
    if (!kind || !model || !version) throw new HttpError(400, 'kind, model e version sono obbligatori')
    const st = this.db.prepare(`INSERT OR REPLACE INTO ai_cache (kind, model, version, uri, value, at) VALUES (?, ?, ?, ?, ?, ?)`)
    const now = Date.now()
    this.tx(() => {
      for (const it of items) if (typeof it.uri === 'string' && it.value !== undefined) st.run(kind, model, version, it.uri, JSON.stringify(it.value), now)
    })
  }

  // ---------- images ----------

  imageGet(url: string): { mime: string; data: Uint8Array } | null {
    return (this.db.prepare(`SELECT mime, data FROM images WHERE url = ?`).get(url) as { mime: string; data: Uint8Array } | undefined) ?? null
  }

  imagePut(url: string, mime: string, data: Uint8Array) {
    this.db.prepare(`INSERT OR REPLACE INTO images (url, mime, data, fetched_at) VALUES (?, ?, ?, ?)`).run(url, mime, data, Date.now())
  }
}

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Local API on the Vite server (dev and `vite preview`): the app's persistent database.
//
//   GET    /api/health
//   GET    /api/analyses                       history of analyses (most recently opened first)
//   POST   /api/analyses            {name}     new analysis
//   PATCH  /api/analyses/:id        {name?, history_kind?, rows?, first_day?, last_day?, display_name?, opened?}
//   DELETE /api/analyses/:id
//   GET    /api/analyses/:id/kv[?store=]       list keys
//   GET    /api/analyses/:id/kv/:store/:key    value (application/octet-stream, packed) or 404
//   PUT    /api/analyses/:id/kv/:store/:key    body = packed value
//   DELETE /api/analyses/:id/kv/:store/:key
//   POST   /api/analyses/:id/kv-batch          body = pack({entries: [[store, key, Uint8Array | null]…]})
//   DELETE /api/analyses/:id/kv/:store         clear one store
//   POST   /api/catalog/get         {uris}     → rows
//   POST   /api/catalog/put         {rows}
//   GET    /api/catalog/stats
//   DELETE /api/catalog
//   POST   /api/catalog/tried/get   {step, uris} → uris
//   POST   /api/catalog/tried/put   {step, uris}
//   DELETE /api/catalog/tried                  forget shared lookups ("riprova falliti")
//   POST   /api/embeddings/get      {model, hashes} → pack({hashes, vecs: Uint8Array[]})
//   POST   /api/embeddings/put      body = pack({model, hashes, vecs: Uint8Array[]})
//   POST   /api/ai/get              {kind, model, version, uris} → [{uri, value}]
//   POST   /api/ai/put              {kind, model, version, items: [{uri, value}]}
//   GET    /api/mb/artist?query=…              MusicBrainz artist search, proxied with an identifying User-Agent and paced
//   GET    /api/img?u=<cover url>              cover image, downloaded once then served from the database
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Connect, Plugin } from 'vite'
import { pack, unpack } from '../src/lib/pack'
import { HttpError, Store, type CatalogRow } from './store'

const IMG_HOSTS = /^(i\.scdn\.co|mosaic\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com)$/i
const MAX_BODY = 512 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > MAX_BODY) {
        fail(new HttpError(413, 'Richiesta troppo grande'))
        req.destroy()
      } else parts.push(c)
    })
    req.on('end', () => ok(Buffer.concat(parts)))
    req.on('error', fail)
  })
}

const json = async <T,>(req: IncomingMessage): Promise<T> => {
  const b = await readBody(req)
  try {
    return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T
  } catch {
    throw new HttpError(400, 'JSON non valido')
  }
}
const bytes = async (req: IncomingMessage) => {
  const b = await readBody(req)
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}
function sendBytes(res: ServerResponse, data: Uint8Array, type = 'application/octet-stream', cache = 'no-store') {
  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader('content-length', String(data.byteLength))
  res.setHeader('cache-control', cache)
  res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
}

// MusicBrainz asks for ≤ 1 request/second per IP and a meaningful User-Agent (browsers can't set one, and
// anonymous traffic gets 503s sooner). One queue here serves every tab and every analysis.
const MB_UA = 'Ascolti/2.0 ( https://github.com/Lumingft18/Spotify-Stats )'
const MB_GAP_MS = 1100
let mbNext = 0
async function mbFetch(path: string): Promise<Response> {
  const now = Date.now()
  const at = Math.max(now, mbNext)
  mbNext = at + MB_GAP_MS
  if (at > now) await new Promise((r) => setTimeout(r, at - now))
  return fetch(`https://musicbrainz.org/ws/2/${path}`, {
    headers: { 'user-agent': MB_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
}

const inflightImg = new Map<string, Promise<{ mime: string; data: Uint8Array } | null>>()

async function fetchImage(store: Store, url: string) {
  const hit = store.imageGet(url)
  if (hit) return hit
  let p = inflightImg.get(url)
  if (!p) {
    p = (async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return null
      const mime = r.headers.get('content-type') ?? 'image/jpeg'
      if (!mime.startsWith('image/')) return null
      const data = new Uint8Array(await r.arrayBuffer())
      store.imagePut(url, mime, data)
      return { mime, data }
    })().finally(() => inflightImg.delete(url))
    inflightImg.set(url, p)
  }
  return p
}

export function createHandler(store: Store): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    // Mounted on /api → req.url is relative to it.
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const m = req.method ?? 'GET'
    void (async () => {
      const [a, b, c, d, e] = parts
      if (a === 'health') return sendJson(res, 200, { ok: true })

      if (a === 'analyses') {
        if (!b) {
          if (m === 'GET') return sendJson(res, 200, store.listAnalyses())
          if (m === 'POST') return sendJson(res, 201, store.createAnalysis((await json<{ name?: string }>(req)).name ?? ''))
        } else if (!c) {
          if (m === 'GET') {
            const row = store.getAnalysis(b)
            return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: 'Analisi non trovata' })
          }
          if (m === 'PATCH') return sendJson(res, 200, store.updateAnalysis(b, await json(req)))
          if (m === 'DELETE') return store.deleteAnalysis(b), sendJson(res, 200, { ok: true })
        } else if (c === 'kv') {
          if (!d && m === 'GET') return sendJson(res, 200, store.kvList(b, url.searchParams.get('store') ?? undefined))
          if (d && !e && m === 'DELETE') return store.kvClear(b, d), sendJson(res, 200, { ok: true })
          if (d && e) {
            if (m === 'GET') {
              const v = store.kvGet(b, d, e)
              // Missing key = empty, not an error (204 keeps the browser console clean).
              if (!v) {
                res.statusCode = 204
                return res.end()
              }
              return sendBytes(res, v)
            }
            if (m === 'PUT') return store.kvSetMany(b, [{ store: d, key: e, value: await bytes(req) }]), sendJson(res, 200, { ok: true })
            if (m === 'DELETE') return store.kvSetMany(b, [{ store: d, key: e, value: null }]), sendJson(res, 200, { ok: true })
          }
        } else if (c === 'kv-batch' && m === 'POST') {
          const { entries } = unpack<{ entries: Array<[string, string, Uint8Array | null]> }>(await bytes(req))
          store.kvSetMany(
            b,
            entries.map(([s, k, v]) => ({ store: s, key: k, value: v })),
          )
          return sendJson(res, 200, { ok: true })
        }
      }

      if (a === 'catalog') {
        if (!b && m === 'DELETE') return store.catalogClear(), sendJson(res, 200, { ok: true })
        if (b === 'stats' && m === 'GET') return sendJson(res, 200, store.catalogStats())
        if (b === 'get' && m === 'POST') return sendJson(res, 200, store.catalogGet((await json<{ uris?: string[] }>(req)).uris ?? []))
        if (b === 'put' && m === 'POST') return sendJson(res, 200, { written: store.catalogPut((await json<{ rows?: CatalogRow[] }>(req)).rows ?? []) })
        if (b === 'tried' && !c && m === 'DELETE') return store.triedClear(), sendJson(res, 200, { ok: true })
        if (b === 'tried' && m === 'POST') {
          const body = await json<{ step?: string; uris?: string[] }>(req)
          if (!body.step) throw new HttpError(400, 'step mancante')
          if (c === 'get') return sendJson(res, 200, store.triedGet(body.step, body.uris ?? []))
          if (c === 'put') return store.triedPut(body.step, body.uris ?? []), sendJson(res, 200, { ok: true })
        }
      }

      if (a === 'embeddings' && m === 'POST') {
        if (b === 'get') {
          const body = await json<{ model?: string; hashes?: string[] }>(req)
          const hits = store.embGet(body.model ?? '', body.hashes ?? [])
          return sendBytes(res, pack({ hashes: [...hits.keys()], vecs: [...hits.values()] }))
        }
        if (b === 'put') {
          const body = unpack<{ model: string; hashes: string[]; vecs: Uint8Array[] }>(await bytes(req))
          store.embPut(
            body.model,
            body.hashes.map((h, i) => ({ hash: h, vec: body.vecs[i] })),
          )
          return sendJson(res, 200, { ok: true })
        }
      }

      if (a === 'ai' && m === 'POST') {
        const body = await json<{ kind?: string; model?: string; version?: string; uris?: string[]; items?: Array<{ uri: string; value: unknown }> }>(req)
        const [k, mo, v] = [body.kind ?? '', body.model ?? '', body.version ?? '']
        if (b === 'get') return sendJson(res, 200, store.aiGet(k, mo, v, body.uris ?? []))
        if (b === 'put') return store.aiPut(k, mo, v, body.items ?? []), sendJson(res, 200, { ok: true })
      }

      if (a === 'mb' && b === 'artist' && m === 'GET') {
        const q = url.searchParams.get('query') ?? ''
        if (!q || q.length > 300) throw new HttpError(400, 'query mancante')
        const r = await mbFetch(`artist/?query=${encodeURIComponent(q)}&limit=1&fmt=json`)
        res.statusCode = r.status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        const ra = r.headers.get('retry-after')
        if (ra) res.setHeader('retry-after', ra)
        return res.end(Buffer.from(await r.arrayBuffer()))
      }

      if (a === 'img' && m === 'GET') {
        const u = url.searchParams.get('u') ?? ''
        let host = ''
        try {
          const parsed = new URL(u)
          host = parsed.protocol === 'https:' ? parsed.hostname : ''
        } catch {
          /* invalid */
        }
        if (!IMG_HOSTS.test(host)) throw new HttpError(400, 'host immagine non consentito')
        const img = await fetchImage(store, u)
        if (!img) throw new HttpError(404, 'immagine non disponibile')
        return sendBytes(res, img.data, img.mime, 'public, max-age=31536000, immutable')
      }

      next()
    })().catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error('[api]', err)
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    })
  }
}

/** Vite plugin: opens the SQLite file and mounts /api on the dev and preview servers. */
export function apiServer(): Plugin {
  let store: Store | null = null
  const getStore = () => (store ??= new Store(resolve(process.env.ASCOLTI_DB ?? 'data/ascolti.sqlite')))
  const mount = (mw: Connect.Server) => mw.use('/api', createHandler(getStore()))
  return {
    name: 'ascolti-api',
    configureServer(s) {
      mount(s.middlewares)
      s.httpServer?.once('close', () => {
        store?.close()
        store = null
      })
    },
    configurePreviewServer(s) {
      mount(s.middlewares)
    },
  }
}

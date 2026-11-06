import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pack, unpack } from '../src/lib/pack'
import { createHandler } from '../server/api'
import { Store } from '../server/store'

describe('pack', () => {
  it('round-trips plain values and typed arrays', () => {
    const v = {
      a: 1,
      s: 'ciao — è',
      n: null,
      list: [1, { f: new Float32Array([0.5, -1, 3.25]) }],
      ipc: new Uint8Array([1, 2, 3, 4, 5]),
      i: new Int32Array([7, -8]),
    }
    const out = unpack<typeof v>(pack(v))
    expect(out.a).toBe(1)
    expect(out.s).toBe('ciao — è')
    expect(out.n).toBeNull()
    expect(Array.from((out.list[1] as { f: Float32Array }).f)).toEqual([0.5, -1, 3.25])
    expect(out.ipc).toBeInstanceOf(Uint8Array)
    expect(Array.from(out.ipc)).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(out.i)).toEqual([7, -8])
  })

  it('handles subarray views and undefined', () => {
    const big = new Float32Array([1, 2, 3, 4])
    const out = unpack<{ v: Float32Array }>(pack({ v: big.subarray(1, 3) }))
    expect(Array.from(out.v)).toEqual([2, 3])
    expect(unpack(pack(undefined))).toBeNull()
  })
})

describe('local API', () => {
  let server: Server
  let base = ''
  const store = new Store(':memory:')

  beforeAll(async () => {
    const handler = createHandler(store)
    server = createServer((req, res) => {
      if (!req.url?.startsWith('/api')) return res.writeHead(404).end()
      req.url = req.url.slice(4) || '/'
      handler(req, res, () => res.writeHead(404).end())
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  })
  afterAll(() => {
    server.close()
    store.close()
  })

  const j = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }

  it('creates, lists, updates and deletes analyses with their data', async () => {
    expect((await j('/analyses', 'POST', { name: '  ' })).status).toBe(400)
    const a = (await j('/analyses', 'POST', { name: 'Gianvito 2025' })).body
    const b = (await j('/analyses', 'POST', { name: 'Chiara' })).body
    expect(a.name).toBe('Gianvito 2025')

    // Binary value (Arrow IPC-like) + typed array inside an object.
    const ipc = new Uint8Array(3_000_000).map((_, i) => i % 251)
    let r = await fetch(`${base}/analyses/${a.id}/kv/kv/plays_ipc`, { method: 'PUT', body: pack(ipc) })
    expect(r.status).toBe(200)
    r = await fetch(`${base}/analyses/${a.id}/kv-batch`, {
      method: 'POST',
      body: pack({ entries: [['kv', 'emb_index', pack({ vecs: new Float32Array([1, 2]) })], ['kv', 'profile', pack({ displayName: 'G' })]] }),
    })
    expect(r.status).toBe(200)

    const got = unpack<Uint8Array>(new Uint8Array(await (await fetch(`${base}/analyses/${a.id}/kv/kv/plays_ipc`)).arrayBuffer()))
    expect(got.length).toBe(ipc.length)
    expect(got[1000]).toBe(1000 % 251)
    const emb = unpack<{ vecs: Float32Array }>(new Uint8Array(await (await fetch(`${base}/analyses/${a.id}/kv/kv/emb_index`)).arrayBuffer()))
    expect(Array.from(emb.vecs)).toEqual([1, 2])

    // Isolation: the other analysis doesn't see it.
    expect((await fetch(`${base}/analyses/${b.id}/kv/kv/plays_ipc`)).status).toBe(204)

    const keys = (await j(`/analyses/${a.id}/kv`)).body as Array<{ key: string }>
    expect(keys.map((k) => k.key).sort()).toEqual(['emb_index', 'plays_ipc', 'profile'])

    const up = (await j(`/analyses/${a.id}`, 'PATCH', { rows: 1234, first_day: '2015-01-01', last_day: '2025-11-01', history_kind: 'extended', opened: true })).body
    expect(up.rows).toBe(1234)
    expect(up.bytes).toBeGreaterThan(3_000_000)
    const list = (await j('/analyses')).body as Array<{ id: string }>
    expect(list[0].id).toBe(a.id) // most recently opened first

    expect((await j(`/analyses/${a.id}`, 'DELETE')).status).toBe(200)
    expect((await fetch(`${base}/analyses/${a.id}/kv/kv/plays_ipc`)).status).toBe(204)
    expect((await j('/analyses')).body).toHaveLength(1)
    expect((await fetch(`${base}/analyses/${a.id}/kv/kv/x`, { method: 'PUT', body: pack(1) })).status).toBe(404)
  })

  it('merges the shared catalog and remembers lookups', async () => {
    await j('/catalog/put', 'POST', { rows: [{ uri: 'spotify:track:1', cover: 'https://i.scdn.co/image/x', valence: 0.4 }, { uri: 'local:x', cover: 'no' }] })
    await j('/catalog/put', 'POST', { rows: [{ uri: 'spotify:track:1', lyrics: 'la la', valence: null }] })
    const rows = (await j('/catalog/get', 'POST', { uris: ['spotify:track:1', 'local:x', 'spotify:track:2'] })).body
    expect(rows).toEqual([{ uri: 'spotify:track:1', cover: 'https://i.scdn.co/image/x', valence: 0.4, lyrics: 'la la' }])

    await j('/catalog/tried/put', 'POST', { step: 'lyrics', uris: ['spotify:track:1', 'spotify:track:9'] })
    expect((await j('/catalog/tried/get', 'POST', { step: 'lyrics', uris: ['spotify:track:9', 'spotify:track:3'] })).body).toEqual(['spotify:track:9'])
    expect((await j('/catalog/tried/get', 'POST', { step: 'covers', uris: ['spotify:track:9'] })).body).toEqual([])

    const st = (await j('/catalog/stats')).body
    expect(st.tracks).toBe(1)
    expect(st.lyrics).toBe(1)
  })

  it('caches embedding vectors by model and hash', async () => {
    const v = new Float32Array([0.1, 0.2, 0.3])
    await fetch(`${base}/embeddings/put`, { method: 'POST', body: pack({ model: 'm@3', hashes: ['h1'], vecs: [new Uint8Array(v.buffer)] }) })
    const res = await fetch(`${base}/embeddings/get`, { method: 'POST', body: JSON.stringify({ model: 'm@3', hashes: ['h1', 'h2'] }) })
    const out = unpack<{ hashes: string[]; vecs: Uint8Array[] }>(new Uint8Array(await res.arrayBuffer()))
    expect(out.hashes).toEqual(['h1'])
    const f = new Float32Array(out.vecs[0].buffer, out.vecs[0].byteOffset, 3)
    expect(f[2]).toBeCloseTo(0.3)
    const other = await fetch(`${base}/embeddings/get`, { method: 'POST', body: JSON.stringify({ model: 'other', hashes: ['h1'] }) })
    expect(unpack<{ hashes: string[] }>(new Uint8Array(await other.arrayBuffer())).hashes).toEqual([])
  })

  it('reuses AI estimates per model and prompt version', async () => {
    const key = { kind: 'mood', model: 'anthropic/claude-haiku-5.5', version: 'v1' }
    await j('/ai/put', 'POST', { ...key, items: [{ uri: 'spotify:track:1', value: { valence: 0.3, energy: 0.8, agreement: 0.5 } }] })
    expect((await j('/ai/get', 'POST', { ...key, uris: ['spotify:track:1', 'spotify:track:2'] })).body).toEqual([
      { uri: 'spotify:track:1', value: { valence: 0.3, energy: 0.8, agreement: 0.5 } },
    ])
    // New prompt, other model or other kind: no hit.
    expect((await j('/ai/get', 'POST', { ...key, version: 'v2', uris: ['spotify:track:1'] })).body).toEqual([])
    expect((await j('/ai/get', 'POST', { ...key, model: 'x', uris: ['spotify:track:1'] })).body).toEqual([])
    expect((await j('/ai/get', 'POST', { ...key, kind: 'mood_bench', uris: ['spotify:track:1'] })).body).toEqual([])
    expect((await j('/ai/put', 'POST', { kind: 'mood', items: [] })).status).toBe(400)
  })

  it('refuses image hosts outside Spotify’s CDN', async () => {
    expect((await fetch(`${base}/img?u=${encodeURIComponent('https://evil.example/x.jpg')}`)).status).toBe(400)
    expect((await fetch(`${base}/img?u=${encodeURIComponent('http://i.scdn.co/x')}`)).status).toBe(400)
  })
})

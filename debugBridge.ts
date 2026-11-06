// Dev-only bridge: lets local tools (curl, an AI assistant in the terminal) inspect the app running in the browser.
// HTTP on the Vite dev server -> HMR websocket -> the open tab answers (src/dev/debugClient.ts) -> HTTP response.
// Never part of a production build (`apply: 'serve'`), only reachable on the dev server's host (localhost by default).
//
//   curl -s localhost:5173/__debug/ping
//   curl -s localhost:5173/__debug/state
//   curl -s localhost:5173/__debug/logs
//   curl -s -X POST localhost:5173/__debug/sql -d '{"sql":"SELECT count(*) FROM meta"}'
//   curl -s localhost:5173/__debug/idb            (list keys)   ?key=mood_report  (read one, truncated)
//   curl -s -X POST localhost:5173/__debug/navigate -d '{"hash":"#/mood"}'
//   curl -s localhost:5173/__debug/reload         (full page reload)
//   curl -s 'localhost:5173/__debug/dom?sel=h1'    (matching elements: size + text)
import type { IncomingMessage } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
    req.on('error', reject)
  })

export function debugBridge(): Plugin {
  const pending = new Map<string, Pending>()
  const logs: unknown[] = []
  let seq = 0
  let server: ViteDevServer

  const ask = (op: string, payload: unknown, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++seq}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Nessuna scheda dell’app ha risposto: apri http://localhost:5173 nel browser.'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      server.ws.send({ type: 'custom', event: 'ascolti:debug-req', data: { id, op, payload } })
    })

  return {
    name: 'ascolti-debug-bridge',
    apply: 'serve',
    configureServer(s) {
      server = s
      s.ws.on('ascolti:debug-res', (msg: { id: string; ok: boolean; data?: unknown; error?: string }) => {
        const p = pending.get(msg.id)
        if (!p) return // another tab answered first
        pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.data)
        else p.reject(new Error(msg.error ?? 'errore'))
      })
      s.ws.on('ascolti:debug-log', (entry: unknown) => {
        logs.push(entry)
        if (logs.length > 500) logs.splice(0, logs.length - 500)
      })

      s.middlewares.use('/__debug', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const send = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1))
        }
        try {
          const route = url.pathname.replace(/\/+$/, '') || '/'
          if (route === '/logs') return send(200, logs.slice(-Number(url.searchParams.get('n') ?? 200)))
          if (route === '/logs/clear') return (logs.length = 0), send(200, { ok: true })
          const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
          switch (route) {
            case '/ping':
              return send(200, await ask('ping', null, 5_000))
            case '/state':
              return send(200, await ask('state', null))
            case '/sql':
              return send(200, await ask('sql', { sql: body.sql ?? url.searchParams.get('q'), params: body.params ?? [] }, 120_000))
            case '/idb':
              return send(200, await ask('idb', { key: url.searchParams.get('key'), store: url.searchParams.get('store') ?? 'kv' }))
            case '/dom':
              return send(200, await ask('dom', { sel: body.sel ?? url.searchParams.get('sel'), limit: url.searchParams.get('limit') ?? 50, chars: url.searchParams.get('chars') ?? 200 }))
            case '/snapshot':
              return send(200, await ask('snapshot', null))
            case '/reload':
              return send(200, await ask('reload', null, 5_000))
            case '/navigate':
              return send(200, await ask('navigate', { hash: body.hash ?? url.searchParams.get('hash') }))
            default:
              return send(404, { error: 'route sconosciuta', routes: ['/ping', '/state', '/logs', '/sql', '/idb', '/navigate', '/reload', '/dom', '/snapshot'] })
          }
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}

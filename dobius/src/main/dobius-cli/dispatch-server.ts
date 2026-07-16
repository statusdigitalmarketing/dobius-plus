import http from 'node:http'
import crypto from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getAsanaSnapshot, markLocalDone } from '../asana/asana-queue-service'
import { installDobiusClis } from './install-clis'

// Localhost dispatch server for the dobius-* CLIs. Hardening copied verbatim from
// the old dobius-plus voice-bridge.js: loopback-only, POST-only, exact Host header
// (anti DNS-rebinding), no Origin (browsers always send one; curl does not), JSON
// content-type, and a constant-time Bearer token compare.
const PORT = 8421
const HOST = '127.0.0.1'
const EXPECTED_HOST_HEADER = `${HOST}:${PORT}`
const MAX_BODY_BYTES = 64 * 1024
const TOKEN_FILE_NAME = 'dobius-cli-token'

// The slice of DobiusRuntimeService the server needs; structural so it stays testable.
export type DobiusCliDispatcher = {
  resolveActiveTerminal: () => Promise<string>
  listTerminals: () => Promise<{
    terminals: { handle: string; title: string | null; worktreePath?: string }[]
  }>
  sendTerminal: (handle: string, action: { text?: string; enter?: boolean }) => Promise<unknown>
}

let server: http.Server | null = null
let bridgeToken: string | null = null
let dispatcher: DobiusCliDispatcher | null = null

export function dobiusCliTokenPath(): string {
  return path.join(app.getPath('userData'), TOKEN_FILE_NAME)
}

function loadOrCreateToken(): void {
  const tokenPath = dobiusCliTokenPath()
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim()
    if (/^[a-f0-9]{64}$/.test(existing)) {
      bridgeToken = existing
      return
    }
  } catch {
    // regenerate below
  }
  bridgeToken = crypto.randomBytes(32).toString('hex')
  try {
    mkdirSync(path.dirname(tokenPath), { recursive: true })
    writeFileSync(tokenPath, bridgeToken, { mode: 0o600 })
    chmodSync(tokenPath, 0o600)
  } catch (err) {
    console.warn(`[dobius-cli] could not persist token: ${(err as Error).message}`)
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function authorized(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    return false
  }
  if (req.method !== 'POST') {
    return false
  }
  if (req.headers.host !== EXPECTED_HOST_HEADER) {
    return false
  }
  if (req.headers.origin !== undefined) {
    return false
  }
  const ct = (req.headers['content-type'] || '').toLowerCase()
  if (!ct.startsWith('application/json')) {
    return false
  }
  const auth = req.headers.authorization || ''
  const expected = `Bearer ${bridgeToken}`
  if (!bridgeToken || auth.length !== expected.length) {
    return false
  }
  return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
}

async function handleTabSend(body: Record<string, unknown>): Promise<unknown> {
  const message = typeof body.message === 'string' ? body.message : ''
  if (!message.trim()) {
    return { ok: false, error: 'message required' }
  }
  if (!dispatcher) {
    return { ok: false, error: 'runtime unavailable' }
  }
  const handle = await dispatcher.resolveActiveTerminal()
  // dobius's sendTerminal appends submission itself when enter:true.
  await dispatcher.sendTerminal(handle, { text: message, enter: true })
  return { ok: true, sent: message.length }
}

function handleTaskDone(body: Record<string, unknown>): unknown {
  const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
  if (!ref) {
    return { ok: false, error: 'ref required' }
  }
  const snapshot = getAsanaSnapshot()
  const all = [...snapshot.build, ...snapshot.review]
  const lower = ref.toLowerCase()
  const match =
    all.find((t) => t.gid === ref) ?? all.find((t) => t.name.toLowerCase().includes(lower))
  if (!match) {
    return {
      ok: false,
      error: 'no matching task',
      candidates: all.map((t) => ({ gid: t.gid, name: t.name }))
    }
  }
  markLocalDone(match.gid)
  return { ok: true, gid: match.gid, name: match.name }
}

async function handleTabList(): Promise<unknown> {
  if (!dispatcher) {
    return { ok: false, error: 'runtime unavailable' }
  }
  const listed = await dispatcher.listTerminals()
  return {
    ok: true,
    tabs: listed.terminals.map((terminal) => ({
      id: terminal.handle,
      title: terminal.title ?? '',
      projectPath: terminal.worktreePath ?? ''
    }))
  }
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, error: (err as Error).message })
    return
  }
  try {
    if (req.url === '/tabSend') {
      sendJson(res, 200, await handleTabSend(body))
      return
    }
    if (req.url === '/taskDone') {
      sendJson(res, 200, handleTaskDone(body))
      return
    }
    if (req.url === '/tabList') {
      sendJson(res, 200, await handleTabList())
      return
    }
    if (req.url === '/getStatus') {
      sendJson(res, 200, { ok: true, snapshot: 'Dobius+ CLI bridge is running.' })
      return
    }
    sendJson(res, 404, { ok: false, error: 'unknown route' })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: (err as Error).message })
  }
}

export async function handleDobiusCliRequestForTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  args: { token: string; dispatcher: DobiusCliDispatcher }
): Promise<void> {
  const previousToken = bridgeToken
  const previousDispatcher = dispatcher
  bridgeToken = args.token
  dispatcher = args.dispatcher
  try {
    await route(req, res)
  } finally {
    bridgeToken = previousToken
    dispatcher = previousDispatcher
  }
}

export function startDobiusCli(runtime: DobiusCliDispatcher): void {
  if (server) {
    return
  }
  dispatcher = runtime
  loadOrCreateToken()
  server = http.createServer((req, res) => {
    void route(req, res)
  })
  server.on('error', (err) => {
    console.warn(`[dobius-cli] server error: ${err.message}`)
    server = null
  })
  server.listen(PORT, HOST, () => {
    console.log(`[dobius-cli] listening on http://${HOST}:${PORT}`)
  })
  installDobiusClis(dobiusCliTokenPath())
}

export function stopDobiusCli(): void {
  if (server) {
    server.close()
    server = null
  }
  dispatcher = null
}

import http from 'node:http'
import crypto from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AsanaQueue, IMessageBridge, VoiceConductor, WorkRegistry } from './types'
import { conductorCliServerAddress, installConductorClis } from './cli-install'
import { handleConductorCliRequest } from './conductor-cli-routing'

// Re-export the pure router so existing importers (service.ts, the tests) keep
// resolving it from './cli-server' after the split.
export { handleConductorCliRequest }

// Localhost-only dispatch server for the Voice Conductor's dobius-* CLIs.
// Ported from v1 electron/voice-bridge.js, with the hardening mirrored from v2's
// src/main/dobius-cli/dispatch-server.ts: loopback-only source IP, POST-only,
// exact Host header (anti DNS-rebinding), no Origin (browsers always send one;
// curl never does), JSON content-type, and a constant-time Bearer token compare.
//
// This is a SEPARATE server from the dobius-cli dispatch server (8421). It binds
// its own port (8422) and its own 0600 token file so the two never collide.
const MAX_BODY_BYTES = 64 * 1024

/**
 * The terminal/runtime seam the conductor CLIs need. The integration lead
 * supplies a real implementation backed by v2's DobiusRuntimeService (the same
 * runtime behind src/main/dobius-cli/dispatch-server.ts's DobiusCliDispatcher).
 * Typed structurally so it stays unit-testable with a fake.
 *
 * Mapping notes for the implementer (v2 runtime → this seam):
 *  - resolveActiveTab  → runtime.resolveActiveTerminal()   (the focused terminal handle)
 *  - sendToTab         → runtime.sendTerminal(handle, { text, enter: true })
 *  - listTabs          → runtime.listTerminals() then map handle→id, worktreePath→projectPath/cwd
 *  - spawnAgent        → v2 custom-agent SDK runner. Starts a fresh windowless run
 *                        in projectPath and returns its run id; older implementations
 *                        may still return a visible terminal tab id.
 *  - getLeadTab/setLeadTab → per-project "lead tab" persistence; v1 stored this in
 *                        agent-spawner's in-memory/config map. Persist in v2 config
 *                        (per-project), NOT in this server (it is stateless).
 */
export type ConductorTab = {
  /** Terminal handle used as the tabId argument to dobius-send. */
  id: string
  title: string
  projectPath: string
  cwd: string
}

export type ConductorTerminalDispatch = {
  /** Focused terminal handle. Fallback target when a verb omits an explicit tabId. */
  resolveActiveTab(): Promise<string>
  /** Write `text` into the tab and submit it (append Enter). Resolves with bytes sent. */
  sendToTab(tabId: string, text: string): Promise<{ sent: number }>
  /** Snapshot of open terminals for dobius-tabs routing. */
  listTabs(): Promise<ConductorTab[]>
  /**
   * Start a fresh agent in `projectPath` and feed `prompt` as its first input.
   * Confirmation is handled by THIS server before this is called. V2 returns a
   * windowless run id; the optional tab id keeps the bridge backward-compatible.
   */
  spawnAgent(
    projectPath: string,
    agentId: string,
    prompt: string
  ): Promise<{ tabId?: string; runId?: string }>
  /** Current lead tab id for a project, or null if none set. */
  getLeadTab(projectPath: string): Promise<string | null>
  /** Set (tabId) or clear (null) the lead tab for a project. */
  setLeadTab(projectPath: string, tabId: string | null): Promise<void>
}

/** Injected leaf modules + terminal seam the server routes each verb to. */
export type ConductorCliDeps = {
  conductor: VoiceConductor
  workRegistry: WorkRegistry
  imessage: IMessageBridge
  asana: AsanaQueue
  terminals: ConductorTerminalDispatch
}

export type ConductorCliResult = { status: number; body: unknown }

let server: http.Server | null = null
let bridgeToken: string | null = null
let deps: ConductorCliDeps | null = null

// --- token (0600 file, per install) -------------------------------------

function loadOrCreateToken(): void {
  const { tokenFile } = conductorCliServerAddress()
  try {
    // Only trust a pre-existing token if the file is a regular file owned by us
    // with 0600 perms — otherwise a readable/preplanted token defeats the auth.
    const st = statSync(tokenFile)
    const ownedByUs = typeof process.getuid === 'function' ? st.uid === process.getuid() : true
    if (st.isFile() && ownedByUs && (st.mode & 0o777) === 0o600) {
      const existing = readFileSync(tokenFile, 'utf8').trim()
      if (/^[a-f0-9]{64}$/.test(existing)) {
        bridgeToken = existing
        return
      }
    }
  } catch {
    // regenerate below
  }
  bridgeToken = crypto.randomBytes(32).toString('hex')
  try {
    mkdirSync(path.dirname(tokenFile), { recursive: true })
    writeFileSync(tokenFile, bridgeToken, { mode: 0o600 })
    chmodSync(tokenFile, 0o600)
  } catch (err) {
    console.warn(`[conductor-cli] could not persist token: ${(err as Error).message}`)
  }
}

// --- socket plumbing ----------------------------------------------------

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
  const { host, port } = conductorCliServerAddress()
  const addr = req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    return false
  }
  if (req.method !== 'POST') {
    return false
  }
  if (req.headers.host !== `${host}:${port}`) {
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

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  if (!deps) {
    sendJson(res, 503, { ok: false, error: 'conductor cli deps not initialized' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, error: (err as Error).message })
    return
  }
  const result = await handleConductorCliRequest(req.url ?? '', body, { authorized: true, deps })
  sendJson(res, result.status, result.body)
}

/**
 * Test-only: drive the full socket path (real Host/Origin/Bearer checks in
 * `authorized`) with an injected token + deps, restoring module state after.
 * Mirrors dobius-cli's handleDobiusCliRequestForTest so the token compare is
 * exercised without booting the real server. Not for production callers.
 */
export async function handleConductorCliRequestForTest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  args: { token: string; deps: ConductorCliDeps }
): Promise<void> {
  const previousToken = bridgeToken
  const previousDeps = deps
  bridgeToken = args.token
  deps = args.deps
  try {
    await route(req, res)
  } finally {
    bridgeToken = previousToken
    deps = previousDeps
  }
}

/**
 * Start the conductor CLI server (idempotent) and install the dobius-* scripts.
 * Call at boot when the Voice Conductor is enabled.
 */
export function startConductorCliServer(input: ConductorCliDeps): void {
  if (server) {
    return
  }
  deps = input
  loadOrCreateToken()
  server = http.createServer((req, res) => {
    // Never let a rejected route() escape as an unhandled rejection (would crash
    // the process); the pure handler already 500s its own errors, this is a backstop.
    route(req, res).catch((err) => {
      try {
        sendJson(res, 500, { ok: false, error: (err as Error).message })
      } catch {
        // response already sent or socket destroyed — nothing to do
      }
    })
  })
  server.on('error', (err) => {
    console.warn(`[conductor-cli] server error: ${err.message}`)
    server = null
  })
  const { host, port } = conductorCliServerAddress()
  server.listen(port, host, () => {
    console.log(`[conductor-cli] listening on http://${host}:${port}`)
  })
  installConductorClis()
}

/** Stop the server and drop injected deps. Call when the conductor is disabled / on quit. */
export function stopConductorCliServer(): void {
  if (server) {
    server.close()
    server = null
  }
  deps = null
}

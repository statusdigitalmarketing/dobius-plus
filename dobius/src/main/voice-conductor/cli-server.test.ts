import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConductorCliDeps, ConductorTab } from './cli-server'

// cli-server imports cli-install which imports electron `app` for the token-file
// path. Stub it so the module loads and conductorCliServerAddress() resolves.
const state = vi.hoisted(() => ({ userData: '' }))
state.userData = mkdtempSync(path.join(tmpdir(), 'conductor-cli-userdata-'))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
}))

type FakeDeps = ConductorCliDeps & {
  conductor: ConductorCliDeps['conductor'] & { setReply: ReturnType<typeof vi.fn> }
  workRegistry: ConductorCliDeps['workRegistry'] & {
    track: ReturnType<typeof vi.fn>
    status: ReturnType<typeof vi.fn>
    markDone: ReturnType<typeof vi.fn>
  }
  imessage: ConductorCliDeps['imessage'] & { ask: ReturnType<typeof vi.fn> }
  asana: ConductorCliDeps['asana'] & { fetch: ReturnType<typeof vi.fn> }
  terminals: ConductorCliDeps['terminals'] & {
    sendToTab: ReturnType<typeof vi.fn>
    listTabs: ReturnType<typeof vi.fn>
    spawnAgent: ReturnType<typeof vi.fn>
  }
}

function makeDeps(): FakeDeps {
  const tabs: ConductorTab[] = [{ id: 'term-1', title: 'Build', projectPath: '/repo', cwd: '/repo' }]
  return {
    conductor: {
      start: vi.fn(),
      stop: vi.fn(),
      isRunning: () => false,
      getStatus: () => ({
        enabled: true,
        running: false,
        runId: null,
        sessionId: null,
        lastError: null
      }),
      postTranscript: vi.fn(async () => {}),
      setReply: vi.fn(() => {}),
      getReply: () => null
    },
    workRegistry: {
      track: vi.fn(() => {}),
      status: vi.fn(() => []),
      markDone: vi.fn(() => null),
      list: vi.fn(() => [])
    },
    imessage: {
      isAvailable: () => true,
      send: vi.fn(),
      ask: vi.fn(async () => 'yes')
    },
    asana: {
      fetch: vi.fn(async () => ({ tasks: [], summary: 'none' }))
    },
    terminals: {
      resolveActiveTab: vi.fn(async () => 'term-1'),
      sendToTab: vi.fn(async () => ({ sent: 5 })),
      listTabs: vi.fn(async () => tabs),
      spawnAgent: vi.fn(async () => ({ tabId: 'term-9' })),
      getLeadTab: vi.fn(async () => null),
      setLeadTab: vi.fn(async () => undefined)
    }
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('handleConductorCliRequest (pure routing)', () => {
  it('/setReply forwards requestId + message to conductor.setReply', async () => {
    const { handleConductorCliRequest } = await import('./cli-server')
    const deps = makeDeps()
    const result = await handleConductorCliRequest(
      '/setReply',
      { requestId: 'req-abc123', message: 'On it' },
      { authorized: true, deps }
    )
    expect(result.status).toBe(200)
    expect(deps.conductor.setReply).toHaveBeenCalledWith('req-abc123', 'On it')
  })

  it('/setReply rejects a malformed requestId without calling setReply', async () => {
    const { handleConductorCliRequest } = await import('./cli-server')
    const deps = makeDeps()
    const result = await handleConductorCliRequest(
      '/setReply',
      { requestId: 'no', message: 'hi' },
      { authorized: true, deps }
    )
    expect(result.status).toBe(400)
    expect(deps.conductor.setReply).not.toHaveBeenCalled()
  })

  it('/trackWork forwards the item to workRegistry.track', async () => {
    const { handleConductorCliRequest } = await import('./cli-server')
    const deps = makeDeps()
    const result = await handleConductorCliRequest(
      '/trackWork',
      { workId: 'wk-1', tabId: 'term-1', requestId: 'req-abc123', description: 'summarize commits' },
      { authorized: true, deps }
    )
    expect(result.status).toBe(200)
    expect(deps.workRegistry.track).toHaveBeenCalledWith({
      workId: 'wk-1',
      tabId: 'term-1',
      requestId: 'req-abc123',
      description: 'summarize commits'
    })
  })

  it('rejects an unauthorized request (401) before touching any dep', async () => {
    const { handleConductorCliRequest } = await import('./cli-server')
    const deps = makeDeps()
    const result = await handleConductorCliRequest(
      '/setReply',
      { requestId: 'req-abc123', message: 'On it' },
      { authorized: false, deps }
    )
    expect(result.status).toBe(401)
    expect(deps.conductor.setReply).not.toHaveBeenCalled()
  })

  it('/spawn confirms via iMessage and only spawns on yes', async () => {
    const { handleConductorCliRequest } = await import('./cli-server')
    const deps = makeDeps()
    deps.imessage.ask.mockResolvedValueOnce('no thanks')
    const declined = await handleConductorCliRequest(
      '/spawn',
      { projectPath: '/repo', agentId: 'builtin-bug-hunter', initialPrompt: 'go' },
      { authorized: true, deps }
    )
    expect((declined.body as { ok: boolean }).ok).toBe(false)
    expect(deps.terminals.spawnAgent).not.toHaveBeenCalled()

    const ok = await handleConductorCliRequest(
      '/spawn',
      { projectPath: '/repo', agentId: 'builtin-bug-hunter', initialPrompt: 'go' },
      { authorized: true, deps }
    )
    expect((ok.body as { ok: boolean }).ok).toBe(true)
    expect(deps.terminals.spawnAgent).toHaveBeenCalledWith('/repo', 'builtin-bug-hunter', 'go')
  })

  it('/spawn returns a V2 windowless agent run id', async () => {
    const { handleConductorCliRequest } = await import('./cli-server')
    const deps = makeDeps()
    deps.terminals.spawnAgent.mockResolvedValueOnce({ runId: 'run-1' })

    const result = await handleConductorCliRequest(
      '/spawn',
      { projectPath: '/repo', agentId: 'builtin-bug-hunter', initialPrompt: 'go' },
      { authorized: true, deps }
    )

    expect(result).toEqual({ status: 200, body: { ok: true, runId: 'run-1' } })
  })
})

// --- socket path: exercises the real Host/Origin/Bearer token checks ---------

async function withServer<T>(
  handler: http.RequestListener,
  run: (port: number) => Promise<T>
): Promise<T> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('test server did not bind a TCP port')
  }
  try {
    return await run(address.port)
  } finally {
    server.close()
  }
}

function post(
  port: number,
  pathname: string,
  bodyObj: unknown,
  token?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          // Host must match conductorCliServerAddress() → 127.0.0.1:8422.
          Host: '127.0.0.1:8422',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('conductor CLI server (socket auth)', () => {
  it('rejects a bad token and accepts the right one', async () => {
    const { handleConductorCliRequestForTest } = await import('./cli-server')
    const deps = makeDeps()
    const token = 'a'.repeat(64)
    await withServer(
      (req, res) => {
        void handleConductorCliRequestForTest(req, res, { token, deps })
      },
      async (port) => {
        await expect(
          post(port, '/setReply', { requestId: 'req-abc123', message: 'hi' }, 'wrong-token')
        ).resolves.toMatchObject({ status: 401 })
        expect(deps.conductor.setReply).not.toHaveBeenCalled()

        await expect(
          post(port, '/setReply', { requestId: 'req-abc123', message: 'hi' }, token)
        ).resolves.toMatchObject({ status: 200, body: { ok: true } })
        expect(deps.conductor.setReply).toHaveBeenCalledWith('req-abc123', 'hi')
      }
    )
  })
})

import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userData: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData
  }
}))

vi.mock('./install-clis', () => ({
  installDobiusClis: vi.fn()
}))

vi.mock('../asana/asana-queue-service', () => ({
  getAsanaSnapshot: () => ({ build: [], review: [] }),
  markLocalDone: vi.fn()
}))

async function withServer<T>(
  handler: http.RequestListener,
  run: (port: number) => Promise<T>
): Promise<T> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
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
  token?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = '{}'
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        Host: '127.0.0.1:8421',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    })
    req.on('response', (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as unknown })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('dobius CLI dispatch server', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(path.join(tmpdir(), 'dobius-cli-userdata-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  it('/tabList requires auth and returns terminal summaries', async () => {
    const mod = await import('./dispatch-server')
    const dispatcher = {
      resolveActiveTerminal: async () => 'term-1',
      sendTerminal: vi.fn(),
      listTerminals: async () => ({
        terminals: [{ handle: 'term-1', title: 'Build', worktreePath: '/repo' }]
      })
    }
    const token = 'a'.repeat(64)

    await withServer(
      (req, res) => {
        void mod.handleDobiusCliRequestForTest(req, res, { token, dispatcher })
      },
      async (port) => {
        await expect(post(port, '/tabList')).resolves.toMatchObject({ status: 401 })
        await expect(post(port, '/tabList', token)).resolves.toEqual({
          status: 200,
          body: { ok: true, tabs: [{ id: 'term-1', title: 'Build', projectPath: '/repo' }] }
        })
      }
    )
  })
})

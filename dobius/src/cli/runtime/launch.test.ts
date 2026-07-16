import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { launchDobiusApp, serveDobiusApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
}

describe('serveDobiusApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    process.env.DOBIUS_APP_EXECUTABLE = '/Applications/Dobius.app/Contents/MacOS/Dobius'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DOBIUS_APP_EXECUTABLE
    delete process.env.DOBIUS_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('pins the Electron child cwd to the app root instead of the caller cwd', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveDobiusApp({ json: true })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Dobius.app/Contents/MacOS/Dobius',
      ['--serve', '--serve-json'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes mobile pairing through to the foreground server child', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(
      serveDobiusApp({
        json: true,
        port: '6768',
        pairingAddress: '100.64.1.20',
        mobilePairing: true
      })
    ).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Dobius.app/Contents/MacOS/Dobius',
      [
        '--serve',
        '--serve-json',
        '--serve-port',
        '6768',
        '--serve-pairing-address',
        '100.64.1.20',
        '--serve-mobile-pairing'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes the app root before serve flags for dev Electron executables', async () => {
    process.env.DOBIUS_APP_EXECUTABLE = '/repo/node_modules/.bin/electron'
    process.env.DOBIUS_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(serveDobiusApp({ json: true, port: '6768' })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/repo/node_modules/.bin/electron',
      [resolve(__dirname, '../../..'), '--serve', '--serve-json', '--serve-port', '6768'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('prints recipe JSON from a detached server child and exits', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const result = serveDobiusApp({
      pairingAddress: 'wss://sandbox.example.com',
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        '{"schemaVersion":1,"pairingCode":"dobius://pair?code=abc","projectRoot":"/workspace/repo"}\n'
      )
    })

    await expect(result).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Dobius.app/Contents/MacOS/Dobius',
      [
        '--serve',
        '--serve-pairing-address',
        'wss://sandbox.example.com',
        '--serve-recipe-json',
        '--serve-project-root',
        '/workspace/repo'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..'),
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
    expect(writeSpy).toHaveBeenCalledWith(
      '{"schemaVersion":1,"pairingCode":"dobius://pair?code=abc","projectRoot":"/workspace/repo"}\n'
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('uses a shell when a Windows npm command shim is the Electron executable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.DOBIUS_APP_EXECUTABLE = 'C:\\repo\\node_modules\\.bin\\electron.cmd'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    try {
      await expect(serveDobiusApp({ json: true })).resolves.toBe(0)
      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\repo\\node_modules\\.bin\\electron.cmd',
        ['--serve', '--serve-json'],
        expect.objectContaining({
          shell: true
        })
      )
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })
})

describe('launchDobiusApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    delete process.env.DOBIUS_OPEN_COMMAND
    delete process.env.DOBIUS_APP_EXECUTABLE
    delete process.env.DOBIUS_APP_EXECUTABLE_NEEDS_APP_ROOT
  })

  it('handles asynchronous detached spawn errors without throwing', async () => {
    process.env.DOBIUS_APP_EXECUTABLE = '/missing/Dobius'
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)

    launchDobiusApp()
    child.emit('error', new Error('ENOENT'))
    await Promise.resolve()

    expect(child.unref).toHaveBeenCalled()
  })
})

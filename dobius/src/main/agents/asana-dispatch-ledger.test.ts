import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  userDataDir: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir)
  }
}))

async function loadLedger() {
  vi.resetModules()
  return import('./asana-dispatch-ledger')
}

beforeEach(() => {
  electronMock.userDataDir = mkdtempSync(path.join(tmpdir(), 'dobius-asana-ledger-'))
})

afterEach(() => {
  rmSync(electronMock.userDataDir, { recursive: true, force: true })
})

describe('asana dispatch ledger', () => {
  it('claims a task idempotently', async () => {
    const ledger = await loadLedger()
    const first = ledger.claimTask('123456', 'build')
    const second = ledger.claimTask('123456', 'build')

    expect(first).toMatchObject({ gid: '123456', lane: 'build', status: 'claimed' })
    expect(second).toBeNull()
    expect(ledger.hasBeenClaimed('123456')).toBe(true)
    expect(ledger.listDispatchRecords()).toHaveLength(1)
  })

  it('dead-letters after two failures', async () => {
    const ledger = await loadLedger()
    ledger.claimTask('123457', 'review')

    expect(ledger.recordFailure('123457')).toMatchObject({ attempts: 1, status: 'failed' })
    expect(ledger.hasBeenClaimed('123457')).toBe(false)
    expect(ledger.claimTask('123457', 'review')).toMatchObject({ status: 'claimed' })
    expect(ledger.recordFailure('123457')).toMatchObject({ attempts: 2, status: 'dead' })
    expect(ledger.isDead('123457')).toBe(true)
    expect(ledger.hasBeenClaimed('123457')).toBe(true)
  })

  it('keeps dead tasks dead', async () => {
    const ledger = await loadLedger()
    ledger.claimTask('123458', 'build')
    ledger.recordFailure('123458')
    ledger.claimTask('123458', 'build')
    ledger.recordFailure('123458')

    expect(ledger.claimTask('123458', 'build')).toBeNull()
    expect(ledger.recordFailure('123458')).toMatchObject({ attempts: 2, status: 'dead' })
  })
})

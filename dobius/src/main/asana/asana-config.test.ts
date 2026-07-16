import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ASANA_CONFIG } from '../../shared/asana'
import { getAsanaConfig, sanitizeConfig, updateAsanaConfig } from './asana-config'

const electronMock = vi.hoisted(() => ({
  userDataDir: ''
}))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') {
        throw new Error(`Unexpected app path: ${name}`)
      }
      return electronMock.userDataDir
    }
  }
}))

describe('sanitizeConfig', () => {
  it('falls back per field while preserving valid values', () => {
    expect(
      sanitizeConfig({
        myGid: ' 999 ',
        reviewGid: '',
        allowedProjects: [{ name: ' Build ', gid: ' 123 ' }, { name: '', gid: '456' }, null],
        autoMode: {
          enabled: true,
          intervalMinutes: 12.8,
          triageAgentId: ' agent-1 ',
          buildAgent: 'codex'
        }
      })
    ).toEqual({
      myGid: '999',
      reviewGid: DEFAULT_ASANA_CONFIG.reviewGid,
      allowedProjects: [{ name: 'Build', gid: '123' }],
      autoMode: {
        enabled: true,
        intervalMinutes: 12,
        triageAgentId: 'agent-1',
        buildAgent: 'codex'
      }
    })
  })

  it('falls back to the default build agent for invalid values', () => {
    expect(
      sanitizeConfig({
        autoMode: { enabled: true, intervalMinutes: 5, buildAgent: 'missing-agent' }
      }).autoMode.buildAgent
    ).toBe('claude')
  })
})

describe('asana config persistence', () => {
  beforeEach(() => {
    electronMock.userDataDir = mkdtempSync(join(tmpdir(), 'dobius-asana-config-'))
  })

  afterEach(() => {
    rmSync(electronMock.userDataDir, { recursive: true, force: true })
  })

  it('round-trips updates through the self-owned JSON file', () => {
    const updated = updateAsanaConfig({
      myGid: '42',
      autoMode: { enabled: true, intervalMinutes: 5 }
    })

    expect(updated).toEqual({
      ...DEFAULT_ASANA_CONFIG,
      myGid: '42',
      autoMode: { enabled: true, intervalMinutes: 5, buildAgent: 'claude' }
    })
    expect(getAsanaConfig()).toEqual(updated)
    expect(
      JSON.parse(readFileSync(join(electronMock.userDataDir, 'asana-config.json'), 'utf-8'))
    ).toEqual(updated)
  })
})

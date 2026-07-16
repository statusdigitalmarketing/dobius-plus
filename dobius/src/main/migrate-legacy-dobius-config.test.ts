import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASANA_CONFIG, type AsanaConfig } from '../shared/asana'

const state = vi.hoisted(() => ({
  userData: '',
  hasToken: false,
  setToken: vi.fn(),
  asanaConfig: null as AsanaConfig | null,
  updateAsanaConfig: vi.fn(),
  addLocalRepoFromPath: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => state.userData
  }
}))

vi.mock('./asana/asana-token-store', () => ({
  hasAsanaToken: () => state.hasToken,
  setAsanaToken: (token: string) => state.setToken(token)
}))

vi.mock('./asana/asana-config', () => ({
  getAsanaConfig: () => state.asanaConfig,
  updateAsanaConfig: (updates: Partial<AsanaConfig>) => {
    state.updateAsanaConfig(updates)
    state.asanaConfig = { ...state.asanaConfig!, ...updates }
    return state.asanaConfig
  }
}))

vi.mock('./ipc/repos', () => ({
  addLocalRepoFromPath: (
    store: unknown,
    projectPath: string,
    kind: 'git' | 'folder'
  ): Promise<unknown> => state.addLocalRepoFromPath(store, projectPath, kind)
}))

function markerPath(): string {
  return path.join(state.userData, 'legacy-config-migrated.json')
}

function writeLegacyConfig(value: unknown): void {
  writeFileSync(path.join(state.userData, 'config.json'), `${JSON.stringify(value)}\n`, 'utf8')
}

function store(repoCount = 0): {
  getRepoCount: () => number
  updateRepo: ReturnType<typeof vi.fn>
} {
  return {
    getRepoCount: () => repoCount,
    updateRepo: vi.fn()
  }
}

describe('migrateLegacyDobiusConfig', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(path.join(tmpdir(), 'dobius-legacy-migration-'))
    state.hasToken = false
    state.setToken.mockReset()
    state.asanaConfig = {
      ...DEFAULT_ASANA_CONFIG,
      allowedProjects: [],
      autoMode: { ...DEFAULT_ASANA_CONFIG.autoMode }
    }
    state.updateAsanaConfig.mockReset()
    state.addLocalRepoFromPath.mockReset()
    state.addLocalRepoFromPath.mockResolvedValue({
      repo: { id: 'repo-1', kind: 'folder' },
      alreadyExisted: false
    })
  })

  it('does nothing without an old config and does not create a marker', async () => {
    const { migrateLegacyDobiusConfig } = await import('./migrate-legacy-dobius-config')
    await migrateLegacyDobiusConfig(store() as never)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('does nothing when the marker already exists', async () => {
    writeLegacyConfig({ asanaQueue: { pat: 'secret' } })
    writeFileSync(markerPath(), '{}', 'utf8')
    const { migrateLegacyDobiusConfig } = await import('./migrate-legacy-dobius-config')
    await migrateLegacyDobiusConfig(store() as never)
    expect(state.setToken).not.toHaveBeenCalled()
  })

  it('imports PAT only when the new token is absent', async () => {
    writeLegacyConfig({ asanaQueue: { pat: ' old-token ' } })
    const { migrateLegacyDobiusConfig } = await import('./migrate-legacy-dobius-config')
    await migrateLegacyDobiusConfig(store() as never)
    expect(state.setToken).toHaveBeenCalledWith('old-token')

    state.setToken.mockReset()
    state.hasToken = true
    state.userData = mkdtempSync(path.join(tmpdir(), 'dobius-legacy-migration-'))
    writeLegacyConfig({ asanaQueue: { pat: 'old-token' } })
    await migrateLegacyDobiusConfig(store() as never)
    expect(state.setToken).not.toHaveBeenCalled()
  })

  it('sanitizes gids and imports auto mode disabled', async () => {
    writeLegacyConfig({
      asanaQueue: {
        myGid: '123456',
        reviewGid: 'not-a-gid',
        allowedProjects: [
          { name: 'Valid', gid: '1234567' },
          { name: 'Invalid', gid: 'abc' }
        ],
        autoMode: { enabled: true, intervalMinutes: 42 }
      }
    })
    const { migrateLegacyDobiusConfig } = await import('./migrate-legacy-dobius-config')
    await migrateLegacyDobiusConfig(store() as never)
    expect(state.updateAsanaConfig).toHaveBeenCalledWith({
      myGid: '123456',
      allowedProjects: [{ name: 'Valid', gid: '1234567' }],
      autoMode: { ...DEFAULT_ASANA_CONFIG.autoMode, enabled: false, intervalMinutes: 42 }
    })
  })

  it('seeds projects only into an empty registry', async () => {
    const projectPath = path.join(state.userData, 'project')
    mkdirSync(projectPath)
    writeLegacyConfig({ projects: { [projectPath]: { displayName: 'Legacy Name' } } })
    const testStore = store()
    const { migrateLegacyDobiusConfig } = await import('./migrate-legacy-dobius-config')
    await migrateLegacyDobiusConfig(testStore as never)

    expect(state.addLocalRepoFromPath).toHaveBeenCalledWith(testStore, projectPath, 'folder')
    expect(testStore.updateRepo).toHaveBeenCalledWith('repo-1', { displayName: 'Legacy Name' })
    expect(JSON.parse(readFileSync(markerPath(), 'utf8'))).toMatchObject({
      imported: {
        projects: [{ path: projectPath, displayName: 'Legacy Name', kind: 'folder', status: 'imported' }]
      }
    })

    state.userData = mkdtempSync(path.join(tmpdir(), 'dobius-legacy-migration-'))
    state.addLocalRepoFromPath.mockClear()
    writeLegacyConfig({ projects: { [projectPath]: { displayName: 'Legacy Name' } } })
    await migrateLegacyDobiusConfig(store(1) as never)
    expect(state.addLocalRepoFromPath).not.toHaveBeenCalled()
  })
})

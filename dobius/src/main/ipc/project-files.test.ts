import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/types'

const { handlers, handleMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

import { registerProjectFilesHandlers } from './project-files'

function makeRepo(repoPath: string): Repo {
  return {
    id: 'repo-1',
    path: repoPath,
    displayName: 'Tutor',
    badgeColor: '#000000',
    addedAt: 0
  }
}

describe('registerProjectFilesHandlers', () => {
  let rootDir = ''
  let repoPath = ''
  let outsidePath = ''
  let repos: Repo[] = []

  const store = {
    getRepos: () => repos
  }

  beforeEach(async () => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })

    rootDir = await mkdtemp(path.join(tmpdir(), 'dobius-project-files-'))
    repoPath = path.join(rootDir, 'repo')
    outsidePath = path.join(rootDir, 'outside')
    await Promise.all([mkdir(repoPath), mkdir(outsidePath)])
    repos = [makeRepo(repoPath)]
    registerProjectFilesHandlers(store as never)
  })

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('rejects unknown repo ids', async () => {
    await expect(handlers.get('project-files:list')!(null, 'missing')).rejects.toThrow(
      'Unknown repository'
    )
  })

  it('rejects root file names outside the allowlist', async () => {
    await expect(handlers.get('project-files:read')!(null, 'repo-1', 'README.md')).rejects.toThrow(
      'Project file is not allowed'
    )
  })

  it('rejects traversal names and invalid rule names', async () => {
    await expect(handlers.get('project-files:read')!(null, 'repo-1', '../x')).rejects.toThrow(
      'Project file is not allowed'
    )
    await expect(
      handlers.get('project-files:read')!(null, 'repo-1', '.claude/rules/../evil.md')
    ).rejects.toThrow('Rule file name is not allowed')
  })

  it('round-trips writes and reads for root files and rule files', async () => {
    await handlers.get('project-files:write')!(null, 'repo-1', 'AGENTS.md', '# Tutor\n')
    await handlers.get('project-files:write')!(
      null,
      'repo-1',
      '.claude/rules/typescript.md',
      '# TypeScript\n'
    )

    await expect(readFile(path.join(repoPath, 'AGENTS.md'), 'utf-8')).resolves.toBe('# Tutor\n')
    await expect(
      handlers.get('project-files:read')!(null, 'repo-1', '.claude/rules/typescript.md')
    ).resolves.toMatchObject({
      name: '.claude/rules/typescript.md',
      content: '# TypeScript\n',
      exists: true
    })
  })

  it('confines rule writes to the real repository path', async () => {
    await symlink(outsidePath, path.join(repoPath, '.claude'), 'dir')

    await expect(
      handlers.get('project-files:write')!(null, 'repo-1', '.claude/rules/escape.md', '# Escape\n')
    ).rejects.toThrow('Project file path escapes the repository')

    await expect(stat(path.join(outsidePath, 'rules'))).rejects.toThrow()
  })
})

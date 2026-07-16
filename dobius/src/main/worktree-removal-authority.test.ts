import { describe, expect, it } from 'vitest'
import {
  canCleanupUnregisteredDobiusWorktreeDirectory,
  isWorktreePathMissing,
  stripDobiusProvenanceMetaUpdates
} from './worktree-removal-safety'
import type { WorktreeMeta } from '../shared/types'

describe('isWorktreePathMissing', () => {
  it('recognizes missing-path errors from local and remote stat providers', async () => {
    await expect(
      isWorktreePathMissing('/missing', async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    ).resolves.toBe(true)

    await expect(
      isWorktreePathMissing('/missing', () => Promise.reject({ code: 'ENOTDIR' }))
    ).resolves.toBe(true)
  })

  it('does not classify existing paths or unrelated stat failures as missing', async () => {
    await expect(isWorktreePathMissing('/exists', async () => ({}))).resolves.toBe(false)

    await expect(
      isWorktreePathMissing('/unknown', async () => {
        throw new Error('permission denied')
      })
    ).resolves.toBe(false)
  })
})

describe('canCleanupUnregisteredDobiusWorktreeDirectory', () => {
  it('does not treat dobiusCreatedAt alone as cleanup authority', () => {
    expect(
      canCleanupUnregisteredDobiusWorktreeDirectory({
        meta: { dobiusCreatedAt: Date.now() }
      })
    ).toBe(false)
    expect(
      canCleanupUnregisteredDobiusWorktreeDirectory({
        meta: {
          dobiusCreatedAt: Date.now(),
          dobiusCreationSource: 'runtime'
        }
      })
    ).toBe(true)
  })

  it('accepts legacy Dobius-created metadata before explicit provenance existed', () => {
    expect(
      canCleanupUnregisteredDobiusWorktreeDirectory({
        meta: { createdAt: Date.now() }
      })
    ).toBe(true)
  })

  it('does not treat creation layout metadata alone as cleanup authority', () => {
    const layoutOnlyMeta: WorktreeMeta = {
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'todo',
      dobiusCreationWorkspaceLayout: { path: '/dobius/workspaces', nestWorkspaces: true }
    }

    expect(
      canCleanupUnregisteredDobiusWorktreeDirectory({
        meta: layoutOnlyMeta
      })
    ).toBe(false)
  })

  it('does not trust paths without provenance or legacy metadata', () => {
    expect(
      canCleanupUnregisteredDobiusWorktreeDirectory({
        meta: undefined
      })
    ).toBe(false)
  })
})

describe('stripDobiusProvenanceMetaUpdates', () => {
  it('removes Dobius-owned provenance fields from user metadata updates', () => {
    expect(
      stripDobiusProvenanceMetaUpdates({
        comment: 'keep me',
        dobiusCreatedAt: 123,
        dobiusCreationSource: 'desktop',
        dobiusCreationWorkspaceLayout: { path: '/workspace', nestWorkspaces: false },
        automationProvenance: {
          kind: 'created-by-automation',
          automationId: 'automation-1',
          automationNameSnapshot: 'Nightly review',
          automationRunId: 'run-1',
          automationRunTitleSnapshot: 'Nightly review run',
          createdAt: 123,
          executionTargetType: 'local',
          executionTargetId: 'local',
          projectId: 'repo-1'
        }
      })
    ).toEqual({ comment: 'keep me' })
  })
})

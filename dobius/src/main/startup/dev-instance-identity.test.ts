import { describe, expect, it } from 'vitest'
import { getDevInstanceIdentity } from './dev-instance-identity'

describe('dev-instance-identity', () => {
  it('keeps packaged identity stable', () => {
    expect(getDevInstanceIdentity(false, {})).toMatchObject({
      name: 'Dobius',
      isDev: false,
      devLabel: null,
      dockBadgeLabel: null,
      appUserModelId: 'com.statusdigitalmarketing.dobius-plus'
    })
  })

  it('derives a readable dev label from worktree and branch env', () => {
    const identity = getDevInstanceIdentity(true, {
      DOBIUS_DEV_REPO_ROOT: '/repo/worktrees/dev-indicator',
      DOBIUS_DEV_WORKTREE_NAME: 'dev-indicator',
      DOBIUS_DEV_BRANCH: 'nwparker/dev-indicator'
    })

    expect(identity).toMatchObject({
      isDev: true,
      devLabel: 'dev-indicator',
      devBranch: 'nwparker/dev-indicator',
      devWorktreeName: 'dev-indicator',
      devRepoRoot: '/repo/worktrees/dev-indicator'
    })
    expect(identity.name).toBe('Dobius: nwparker/dev-indicator')
    expect(identity.dockBadgeLabel).toBeNull()
    expect(identity.appUserModelId).toMatch(
      /^com\.statusdigitalmarketing\.dobius-plus\.dev\.[a-f0-9]{10}$/
    )
  })

  it('includes the branch when it differs from the worktree basename', () => {
    const identity = getDevInstanceIdentity(true, {
      DOBIUS_DEV_REPO_ROOT: '/repo/worktrees/payment-ui',
      DOBIUS_DEV_WORKTREE_NAME: 'payment-ui',
      DOBIUS_DEV_BRANCH: 'feature/billing-shell'
    })

    expect(identity.devLabel).toBe('payment-ui @ feature/billing-shell')
    expect(identity.name).toBe('Dobius: feature/billing-shell')
    expect(identity.dockBadgeLabel).toBeNull()
  })

  it('allows an explicit label override', () => {
    const identity = getDevInstanceIdentity(true, {
      DOBIUS_DEV_INSTANCE_LABEL: 'manual label',
      DOBIUS_DEV_WORKTREE_NAME: 'dev-indicator',
      DOBIUS_DEV_BRANCH: 'feature/other'
    })

    expect(identity.devLabel).toBe('manual label')
    expect(identity.name).toBe('Dobius: feature/other')
    expect(identity.dockBadgeLabel).toBeNull()
  })
})

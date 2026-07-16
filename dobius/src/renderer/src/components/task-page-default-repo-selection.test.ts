import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import {
  getDefaultTaskRepoSelection,
  getTaskProjectPickerGroups,
  getTaskProjectPickerRepos,
  normalizeTaskRepoSelection
} from './task-page-default-repo-selection'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

describe('getDefaultTaskRepoSelection', () => {
  it('selects one source per logical GitHub project', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({
        id: 'local-dobius',
        upstream: { owner: 'statusdigitalmarketing', repo: 'Dobius' }
      }),
      repo({
        id: 'ssh-dobius',
        connectionId: 'builder',
        upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
      }),
      repo({
        id: 'other',
        upstream: { owner: 'statusdigitalmarketing', repo: 'other' }
      })
    ])

    expect([...selection].sort()).toEqual(['local-dobius', 'other'])
  })

  it('prefers local checkout over a remote checkout for the same project', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({
        id: 'ssh-dobius',
        addedAt: 1,
        connectionId: 'builder',
        upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
      }),
      repo({
        id: 'local-dobius',
        addedAt: 2,
        upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
      })
    ])

    expect([...selection]).toEqual(['local-dobius'])
  })

  it('keeps same-named folders separate when provider identity is missing', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({ id: 'local-app', displayName: 'app' }),
      repo({ id: 'ssh-app', displayName: 'app', connectionId: 'builder' })
    ])

    expect([...selection].sort()).toEqual(['local-app', 'ssh-app'])
  })

  it('uses GitHub repo icon metadata to identify legacy duplicate projects', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({
        id: 'local-claude-swap',
        displayName: 'claude-swap',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/statusdigitalmarketing.png?size=64',
          source: 'github',
          label: 'statusdigitalmarketing/claude-swap'
        }
      }),
      repo({
        id: 'ssh-claude-swap',
        displayName: 'claude-swap',
        connectionId: 'builder',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/statusdigitalmarketing.png?size=64',
          source: 'github',
          label: 'statusdigitalmarketing/claude-swap'
        }
      })
    ])

    expect([...selection]).toEqual(['local-claude-swap'])
  })
})

describe('getTaskProjectPickerRepos', () => {
  it('shows one picker row per logical GitHub project', () => {
    const pickerRepos = getTaskProjectPickerRepos([
      repo({
        id: 'local-dobius',
        upstream: { owner: 'statusdigitalmarketing', repo: 'Dobius' }
      }),
      repo({
        id: 'ssh-dobius',
        connectionId: 'builder',
        upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
      }),
      repo({
        id: 'other',
        upstream: { owner: 'statusdigitalmarketing', repo: 'other' }
      })
    ])

    expect(pickerRepos.map((candidate) => candidate.id)).toEqual(['local-dobius', 'other'])
  })

  it('uses an explicitly selected remote source as the visible project row', () => {
    const pickerRepos = getTaskProjectPickerRepos(
      [
        repo({
          id: 'local-dobius',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        }),
        repo({
          id: 'ssh-dobius',
          connectionId: 'builder',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        })
      ],
      new Set(['ssh-dobius'])
    )

    expect(pickerRepos.map((candidate) => candidate.id)).toEqual(['ssh-dobius'])
  })

  it('collapses legacy local and SSH rows that share a GitHub repo icon identity', () => {
    const pickerRepos = getTaskProjectPickerRepos([
      repo({
        id: 'local-claude-swap',
        displayName: 'claude-swap',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/statusdigitalmarketing.png?size=64',
          source: 'github',
          label: 'statusdigitalmarketing/claude-swap'
        }
      }),
      repo({
        id: 'ssh-claude-swap',
        displayName: 'claude-swap',
        connectionId: 'builder',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/statusdigitalmarketing.png?size=64',
          source: 'github',
          label: 'statusdigitalmarketing/claude-swap'
        }
      })
    ])

    expect(pickerRepos.map((candidate) => candidate.id)).toEqual(['local-claude-swap'])
  })
})

describe('getTaskProjectPickerGroups', () => {
  it('keeps all host sources under one logical project row', () => {
    const groups = getTaskProjectPickerGroups([
      repo({
        id: 'local-dobius',
        upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
      }),
      repo({
        id: 'ssh-dobius',
        connectionId: 'builder',
        upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
      }),
      repo({
        id: 'docs',
        upstream: { owner: 'statusdigitalmarketing', repo: 'docs' }
      })
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      projectKey: 'github:statusdigitalmarketing/dobius-plus',
      repo: { id: 'local-dobius' }
    })
    expect(groups[0]?.sources.map((source) => source.id)).toEqual(['local-dobius', 'ssh-dobius'])
    expect(groups[1]).toMatchObject({
      projectKey: 'github:statusdigitalmarketing/docs',
      repo: { id: 'docs' }
    })
  })

  it('uses the explicitly selected source as the project representative', () => {
    const groups = getTaskProjectPickerGroups(
      [
        repo({
          id: 'local-dobius',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        }),
        repo({
          id: 'ssh-dobius',
          connectionId: 'builder',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        })
      ],
      new Set(['ssh-dobius'])
    )

    expect(groups[0]?.repo.id).toBe('ssh-dobius')
    expect(groups[0]?.sources.map((source) => source.id)).toEqual(['local-dobius', 'ssh-dobius'])
  })
})

describe('normalizeTaskRepoSelection', () => {
  it('collapses duplicate selected sources for the same logical project', () => {
    const selection = normalizeTaskRepoSelection(
      [
        repo({
          id: 'local-dobius',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        }),
        repo({
          id: 'ssh-dobius',
          connectionId: 'builder',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        })
      ],
      new Set(['local-dobius', 'ssh-dobius'])
    )

    expect([...selection]).toEqual(['local-dobius'])
  })

  it('preserves a single explicit remote source selection', () => {
    const selection = normalizeTaskRepoSelection(
      [
        repo({
          id: 'local-dobius',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        }),
        repo({
          id: 'ssh-dobius',
          connectionId: 'builder',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        })
      ],
      new Set(['ssh-dobius'])
    )

    expect([...selection]).toEqual(['ssh-dobius'])
  })

  it('normalizes raw all-host selection to one source per logical project', () => {
    const selection = normalizeTaskRepoSelection(
      [
        repo({
          id: 'local-dobius',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        }),
        repo({
          id: 'ssh-dobius',
          connectionId: 'builder',
          upstream: { owner: 'statusdigitalmarketing', repo: 'dobius' }
        }),
        repo({
          id: 'docs',
          upstream: { owner: 'statusdigitalmarketing', repo: 'docs' }
        })
      ],
      new Set(['local-dobius', 'ssh-dobius', 'docs'])
    )

    expect([...selection].sort()).toEqual(['docs', 'local-dobius'])
  })
})

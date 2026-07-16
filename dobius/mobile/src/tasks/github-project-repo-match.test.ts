import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  normalizeGitHubRepositorySlug
} from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/Users/me/dobius', displayName: 'dobius' },
  { id: 'repo-2', path: '/Users/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
  it('normalizes owner/repo slugs case-insensitively', () => {
    expect(normalizeGitHubRepositorySlug(' statusdigitalmarketing/Dobius ')).toBe('statusdigitalmarketing/dobius-plus')
    expect(normalizeGitHubRepositorySlug('dobius')).toBeNull()
    expect(normalizeGitHubRepositorySlug('statusdigitalmarketing/dobius-plus/extra')).toBeNull()
  })

  it('matches project rows by resolved repo slug before path/display heuristics', () => {
    expect(
      findRepoForGitHubProjectRepository('statusdigitalmarketing/dobius-plus', repos, {
        'repo-1': { path: '/Users/me/dobius', slug: 'statusdigitalmarketing/dobius-plus' }
      })
    ).toBe(repos[0])
  })

  it('does not pick a repo when resolved slugs are ambiguous', () => {
    expect(
      findRepoForGitHubProjectRepository('statusdigitalmarketing/dobius-plus', repos, {
        'repo-1': { path: '/Users/me/dobius', slug: 'statusdigitalmarketing/dobius-plus' },
        'repo-2': { path: '/Users/me/other', slug: 'statusdigitalmarketing/dobius-plus' }
      })
    ).toBeNull()
  })

  it('falls back to exact display/path slug matching when slug resolution is unavailable', () => {
    expect(
      findRepoForGitHubProjectRepository('statusdigitalmarketing/dobius-plus', [
        { id: 'repo-1', path: '/Users/me/statusdigitalmarketing/dobius-plus', displayName: 'dobius' }
      ])
    ).toEqual({ id: 'repo-1', path: '/Users/me/statusdigitalmarketing/dobius-plus', displayName: 'dobius' })
  })

  it('normalizes Windows paths before path slug fallback matching', () => {
    expect(
      findRepoForGitHubProjectRepository('statusdigitalmarketing/dobius-plus', [
        { id: 'repo-1', path: 'C:\\Users\\me\\statusdigitalmarketing\\dobius', displayName: 'dobius' }
      ])
    ).toEqual({ id: 'repo-1', path: 'C:\\Users\\me\\statusdigitalmarketing\\dobius', displayName: 'dobius' })
  })

  it('does not path-match a repo whose resolved slug points somewhere else', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'statusdigitalmarketing/dobius-plus',
        [{ id: 'repo-1', path: '/Users/me/statusdigitalmarketing/dobius-plus', displayName: 'dobius' }],
        {
          'repo-1': { path: '/Users/me/statusdigitalmarketing/dobius-plus', slug: 'fork/dobius' }
        }
      )
    ).toBeNull()
  })

  it('filters project rows to rows backed by open repositories', () => {
    const rows = [
      { id: 'row-1', content: { repository: 'statusdigitalmarketing/dobius-plus' } },
      { id: 'row-2', content: { repository: 'other/missing' } },
      { id: 'row-3', content: { repository: null } }
    ]

    expect(
      filterGitHubProjectRowsForRepos(rows, repos, {
        'repo-1': { path: '/Users/me/dobius', slug: 'statusdigitalmarketing/dobius-plus' }
      }).map((row) => row.id)
    ).toEqual(['row-1'])
  })
})

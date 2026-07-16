import { describe, expect, it } from 'vitest'
import {
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback
} from './github-work-item-source-errors'

describe('extractGitHubIssueSourceError', () => {
  it('keeps the failing issue source slug with the repo that produced it', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/dobius' },
        {
          sources: { issues: { owner: 'upstream', repo: 'dobius' } },
          errors: { issues: { message: 'HTTP 403: resource not accessible' } }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/dobius',
      source: { owner: 'upstream', repo: 'dobius' },
      message: 'HTTP 403: resource not accessible'
    })
  })

  it('drops issue errors when the source slug is unavailable', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/dobius' },
        {
          sources: { issues: null },
          errors: { issues: { message: 'failed' } }
        }
      )
    ).toBeNull()
  })

  it('returns null when the envelope has no issue-side error', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/dobius' },
        {
          sources: { issues: { owner: 'statusdigitalmarketing', repo: 'dobius' } }
        }
      )
    ).toBeNull()
  })
})

describe('extractGitHubIssueSourceFallback', () => {
  it('reports the repo whose upstream issue source fell back to origin', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/dobius', displayName: 'dobius' },
        {
          issueSourceFellBack: true,
          sources: {
            issues: { owner: 'statusdigitalmarketing', repo: 'dobius-fork' },
            prs: { owner: 'statusdigitalmarketing', repo: 'dobius' }
          }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/dobius',
      repoLabel: 'statusdigitalmarketing/dobius-plus'
    })
  })

  it('uses the Dobius repo display name when the PR source is unavailable', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/dobius', displayName: 'dobius' },
        {
          issueSourceFellBack: true,
          sources: { issues: null, prs: null }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/dobius',
      repoLabel: 'dobius'
    })
  })

  it('returns null when the source resolver did not fall back', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/dobius', displayName: 'dobius' },
        {
          sources: { issues: { owner: 'statusdigitalmarketing', repo: 'dobius' } }
        }
      )
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Project, ProjectHostSetup, Repo } from '../../../shared/types'
import {
  resolveWorkspaceCreationRepoId,
  resolveWorkspaceCreationTarget
} from './project-host-workspace-target'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

function makeProject(
  id: string,
  sourceRepoIds: string[],
  overrides: Partial<Project> = {}
): Project {
  return {
    id,
    displayName: id,
    badgeColor: '#000000',
    sourceRepoIds,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeSetup(
  id: string,
  projectId: string,
  hostId: ExecutionHostId,
  repoId: string,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId,
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('project-host workspace target resolution', () => {
  it('falls back to a local setup for a local-only repo', () => {
    const repo = makeRepo('dobius')

    const resolution = resolveWorkspaceCreationTarget({ eligibleRepos: [repo] })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        projectId: 'repo:dobius',
        hostId: 'local',
        projectHostSetupId: 'dobius',
        repoId: 'dobius'
      }
    })
  })

  it('chooses the focused host setup when one project exists on multiple hosts', () => {
    const repos = [makeRepo('dobius-local'), makeRepo('dobius-ssh', { connectionId: 'openclaw-2' })]
    const projects = [makeProject('github:statusdigitalmarketing/dobius-plus', ['dobius-local', 'dobius-ssh'])]
    const projectHostSetups = [
      makeSetup('dobius-local', 'github:statusdigitalmarketing/dobius-plus', 'local', 'dobius-local'),
      makeSetup('dobius-ssh', 'github:statusdigitalmarketing/dobius-plus', 'ssh:openclaw-2', 'dobius-ssh')
    ]

    expect(
      resolveWorkspaceCreationRepoId({
        eligibleRepos: repos,
        projects,
        projectHostSetups,
        projectId: 'github:statusdigitalmarketing/dobius-plus',
        focusedHostScope: 'ssh:openclaw-2'
      })
    ).toBe('dobius-ssh')
  })

  it('resolves an explicit project and host to the matching setup', () => {
    const repos = [
      makeRepo('dobius-local'),
      makeRepo('dobius-runtime', { executionHostId: 'runtime:gpu-1' })
    ]
    const projects = [makeProject('github:statusdigitalmarketing/dobius-plus', ['dobius-local', 'dobius-runtime'])]
    const projectHostSetups = [
      makeSetup('dobius-local', 'github:statusdigitalmarketing/dobius-plus', 'local', 'dobius-local'),
      makeSetup('dobius-runtime', 'github:statusdigitalmarketing/dobius-plus', 'runtime:gpu-1', 'dobius-runtime')
    ]

    const resolution = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects,
      projectHostSetups,
      projectId: 'github:statusdigitalmarketing/dobius-plus',
      hostId: 'runtime:gpu-1'
    })

    expect(resolution).toMatchObject({
      status: 'ready',
      target: {
        projectId: 'github:statusdigitalmarketing/dobius-plus',
        hostId: 'runtime:gpu-1',
        projectHostSetupId: 'dobius-runtime',
        repoId: 'dobius-runtime'
      }
    })
  })

  it('does not merge same-name repos without shared project identity', () => {
    const repos = [
      makeRepo('personal-dobius', { displayName: 'dobius' }),
      makeRepo('work-dobius', { displayName: 'dobius', connectionId: 'work-linux' })
    ]

    expect(
      resolveWorkspaceCreationRepoId({
        eligibleRepos: repos,
        projectId: 'repo:personal-dobius',
        focusedHostScope: 'ssh:work-linux'
      })
    ).toBe('personal-dobius')
  })

  it('reports unavailable when the project is not set up on the selected host', () => {
    const repo = makeRepo('dobius')
    const projects = [makeProject('github:statusdigitalmarketing/dobius-plus', ['dobius'])]
    const projectHostSetups = [makeSetup('dobius', 'github:statusdigitalmarketing/dobius-plus', 'local', 'dobius')]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectId: 'github:statusdigitalmarketing/dobius-plus',
        hostId: 'ssh:openclaw-2'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'project-not-set-up-on-host'
    })
  })

  it('reports setup-not-ready when the selected host has pending setup metadata', () => {
    const repo = makeRepo('dobius')
    const projects = [makeProject('github:statusdigitalmarketing/dobius-plus', ['dobius'])]
    const projectHostSetups = [
      makeSetup('dobius', 'github:statusdigitalmarketing/dobius-plus', 'local', 'dobius'),
      makeSetup('gpu-pending', 'github:statusdigitalmarketing/dobius-plus', 'runtime:gpu', '', {
        path: '',
        setupState: 'setting-up',
        setupMethod: 'provisioned'
      })
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectId: 'github:statusdigitalmarketing/dobius-plus',
        hostId: 'runtime:gpu'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'setup-not-ready'
    })
  })

  it('reports unavailable when an explicit setup is not ready', () => {
    const repo = makeRepo('dobius')
    const projects = [makeProject('github:statusdigitalmarketing/dobius-plus', ['dobius'])]
    const projectHostSetups = [
      makeSetup('dobius', 'github:statusdigitalmarketing/dobius-plus', 'local', 'dobius', { setupState: 'setting-up' })
    ]

    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [repo],
        projects,
        projectHostSetups,
        projectHostSetupId: 'dobius'
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'setup-not-ready'
    })
  })

  // Regression: selecting a project in the new-workspace dropdown must not be
  // pinned to the host of the currently-active workspace. Each project below is
  // set up on exactly one (different) host; picking the other project while the
  // current host is given only as a preference must resolve to that project's
  // own host instead of returning '' (the silent no-op the dropdown showed).
  describe('cross-host project selection', () => {
    const repos = [makeRepo('local-repo'), makeRepo('remote-repo', { connectionId: 'remote-1' })]
    const projects = [
      makeProject('repo:local-repo', ['local-repo']),
      makeProject('repo:remote-repo', ['remote-repo'])
    ]
    const projectHostSetups = [
      makeSetup('local-repo', 'repo:local-repo', 'local', 'local-repo'),
      makeSetup('remote-repo', 'repo:remote-repo', 'ssh:remote-1', 'remote-repo')
    ]

    it('resolves a remote-only project while the current host is local', () => {
      expect(
        resolveWorkspaceCreationRepoId({
          eligibleRepos: repos,
          projects,
          projectHostSetups,
          projectId: 'repo:remote-repo',
          focusedHostScope: 'local'
        })
      ).toBe('remote-repo')
    })

    it('resolves a local-only project while the current host is remote', () => {
      expect(
        resolveWorkspaceCreationRepoId({
          eligibleRepos: repos,
          projects,
          projectHostSetups,
          projectId: 'repo:local-repo',
          focusedHostScope: 'ssh:remote-1'
        })
      ).toBe('local-repo')
    })

    it('still prefers the current host when the project is set up on it', () => {
      const multiHostProjects = [makeProject('repo:multi', ['multi-local', 'multi-remote'])]
      const multiHostSetups = [
        makeSetup('multi-local', 'repo:multi', 'local', 'multi-local'),
        makeSetup('multi-remote', 'repo:multi', 'ssh:remote-1', 'multi-remote')
      ]

      expect(
        resolveWorkspaceCreationRepoId({
          eligibleRepos: [
            makeRepo('multi-local'),
            makeRepo('multi-remote', { connectionId: 'remote-1' })
          ],
          projects: multiHostProjects,
          projectHostSetups: multiHostSetups,
          projectId: 'repo:multi',
          focusedHostScope: 'local'
        })
      ).toBe('multi-local')
    })

    it('still reports unavailable for an explicit project+host with no ready setup', () => {
      // The strict projectId+hostId path (used by the explicit "Run on" host
      // picker) keeps its hard match — only the project-dropdown call site
      // changed to pass the host as a preference.
      expect(
        resolveWorkspaceCreationTarget({
          eligibleRepos: repos,
          projects,
          projectHostSetups,
          projectId: 'repo:remote-repo',
          hostId: 'local'
        })
      ).toEqual({
        status: 'unavailable',
        reason: 'project-not-set-up-on-host'
      })
    })
  })
})

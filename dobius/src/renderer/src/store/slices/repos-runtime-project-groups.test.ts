import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice runtime project groups', () => {
  it('keeps runtime copies of a grouped canonical project in the same project group', async () => {
    const gitRemoteIdentity = {
      canonicalKey: 'github.com/statusdigitalmarketing/dobius-plus',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/statusdigitalmarketing/dobius-plus.git'
    }
    const localDobius: Repo = {
      id: 'local-dobius',
      path: '/Users/alice/stably/dobius',
      displayName: 'dobius',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local',
      gitRemoteIdentity,
      projectGroupId: 'group-dobius'
    }
    const runtimeDobius: Repo = {
      id: 'runtime-dobius',
      path: '/vercel/sandbox/dobius',
      displayName: 'dobius',
      badgeColor: '#111',
      addedAt: 2,
      gitRemoteIdentity
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-runtime-dobius',
      ok: true,
      result: { repos: [runtimeDobius] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localDobius]
    })

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([
      localDobius,
      {
        ...runtimeDobius,
        executionHostId: 'runtime:env-1',
        projectGroupId: 'group-dobius'
      }
    ])
  })
})

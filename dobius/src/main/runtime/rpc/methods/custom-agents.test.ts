import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { DobiusRuntimeService } from '../../dobius-runtime'

// Why: agents-store and agent-runner import electron/the Claude SDK at module
// scope, so both are mocked before the methods module loads them.
vi.mock('../../../agents/agents-store', () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  removeAgent: vi.fn()
}))
vi.mock('../../../agents/agent-runner', () => ({
  listAgentRuns: vi.fn(),
  startAgentRun: vi.fn()
}))
vi.mock('../../../agents/default-claude-launch', () => ({
  getDefaultPrepareClaudeLaunch: vi.fn()
}))

import {
  createAgent,
  getAgent,
  listAgents,
  removeAgent,
  updateAgent
} from '../../../agents/agents-store'
import { listAgentRuns, startAgentRun } from '../../../agents/agent-runner'
import { getDefaultPrepareClaudeLaunch } from '../../../agents/default-claude-launch'
import { CUSTOM_AGENT_METHODS } from './custom-agents'

const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as DobiusRuntimeService

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(): RpcDispatcher {
  return new RpcDispatcher({ runtime, methods: CUSTOM_AGENT_METHODS })
}

describe('custom agent RPC methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists, shows, and deletes agents through the store', async () => {
    const agent = { id: 'agent-1', name: 'Reviewer' }
    vi.mocked(listAgents).mockReturnValue([agent] as never)
    vi.mocked(getAgent).mockReturnValue(agent as never)
    const dispatcher = makeDispatcher()

    await expect(dispatcher.dispatch(makeRequest('agent.list'))).resolves.toMatchObject({
      ok: true,
      result: { agents: [agent] }
    })
    await expect(
      dispatcher.dispatch(makeRequest('agent.show', { id: 'agent-1' }))
    ).resolves.toMatchObject({ ok: true, result: { agent } })
    await expect(
      dispatcher.dispatch(makeRequest('agent.delete', { id: 'agent-1' }))
    ).resolves.toMatchObject({ ok: true, result: { removed: true, id: 'agent-1' } })
    expect(removeAgent).toHaveBeenCalledWith('agent-1')
  })

  it('rejects show for a missing agent', async () => {
    vi.mocked(getAgent).mockReturnValue(null)
    await expect(
      makeDispatcher().dispatch(makeRequest('agent.show', { id: 'ghost' }))
    ).resolves.toMatchObject({ ok: false })
  })

  it('returns the newly appended agent from create and the edited agent from update', async () => {
    const older = { id: 'agent-1', name: 'Old' }
    const created = { id: 'agent-2', name: 'Reviewer' }
    vi.mocked(createAgent).mockReturnValue([older, created] as never)
    vi.mocked(updateAgent).mockReturnValue([older, created] as never)
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(
        makeRequest('agent.create', { name: 'Reviewer', allowedTools: ['Read', 'Bash'] })
      )
    ).resolves.toMatchObject({ ok: true, result: { agent: created } })
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Reviewer', allowedTools: ['Read', 'Bash'] })
    )

    await expect(
      dispatcher.dispatch(
        makeRequest('agent.update', { id: 'agent-1', updates: { model: 'claude-fable-5' } })
      )
    ).resolves.toMatchObject({ ok: true, result: { agent: older } })
    expect(updateAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({ model: 'claude-fable-5' })
    )
  })

  it('starts runs with the registered launch preparer and refuses without one', async () => {
    const prepare = vi.fn()
    vi.mocked(getDefaultPrepareClaudeLaunch).mockReturnValue(prepare)
    vi.mocked(startAgentRun).mockResolvedValue('run-1')
    const dispatcher = makeDispatcher()

    await expect(
      dispatcher.dispatch(makeRequest('agent.run', { id: 'agent-1', prompt: 'Review PRs' }))
    ).resolves.toMatchObject({ ok: true, result: { runId: 'run-1' } })
    expect(startAgentRun).toHaveBeenCalledWith({
      agentId: 'agent-1',
      prompt: 'Review PRs',
      prepareClaudeLaunch: prepare
    })

    vi.mocked(getDefaultPrepareClaudeLaunch).mockReturnValue(null)
    await expect(
      dispatcher.dispatch(makeRequest('agent.run', { id: 'agent-1', prompt: 'Review PRs' }))
    ).resolves.toMatchObject({ ok: false })
  })

  it('filters run history by agent id', async () => {
    const runs = [
      { id: 'run-1', agentId: 'agent-1' },
      { id: 'run-2', agentId: 'agent-2' }
    ]
    vi.mocked(listAgentRuns).mockReturnValue(runs as never)
    await expect(
      makeDispatcher().dispatch(makeRequest('agent.runs', { agentId: 'agent-2' }))
    ).resolves.toMatchObject({ ok: true, result: { runs: [{ id: 'run-2', agentId: 'agent-2' }] } })
  })
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CustomAgent } from '../../shared/agents'
import { createConductorAgentSpawner } from './agent-spawn'

const agent = {
  id: 'agent-1',
  name: 'Bug Hunter',
  description: '',
  icon: 'bot',
  color: '#b9bcc2',
  systemPrompt: '',
  model: 'claude-opus-4-8',
  cwd: '',
  allowedTools: [],
  skills: [],
  bypassPermissions: false,
  heartbeat: {
    enabled: false,
    frequency: 'hourly',
    at: '09:00',
    quietStart: '22:00',
    quietEnd: '07:00',
    maxBudgetUsd: 1,
    maxTurns: 20
  },
  notify: 'urgent only',
  channels: { imessage: false },
  createdAt: 1,
  updatedAt: 1
} satisfies CustomAgent

const preparation = {
  configDir: '/tmp/claude',
  envPatch: {},
  stripAuthEnv: false,
  provenance: 'test'
}

describe('Voice Conductor agent spawning', () => {
  it('starts a fresh custom-agent run in the requested project and reports completion', async () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), 'dobius-spawn-'))
    const notify = vi.fn(async () => {})
    const startAgentRun = vi.fn(async (args) => {
      args.options.onResult({ subtype: 'success', result: 'Fixed the issue' })
      return 'run-1'
    })
    const prepare = vi.fn(async () => preparation)
    const spawner = createConductorAgentSpawner({
      listAgents: () => [agent],
      getPrepareClaudeLaunch: () => prepare,
      startAgentRun,
      notify
    })

    await expect(spawner.spawn(projectPath, 'bug hunter', ' fix it ')).resolves.toEqual({
      runId: 'run-1'
    })
    expect(startAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', cwd: projectPath, prompt: 'fix it' })
    )
    expect(startAgentRun.mock.calls[0][0].options).toMatchObject({ source: 'channel', resume: false })
    expect(notify).toHaveBeenCalledWith('Bug Hunter finished: Fixed the issue')
  })

  it('rejects unknown agents and missing project folders', async () => {
    const spawner = createConductorAgentSpawner({
      listAgents: () => [agent],
      getPrepareClaudeLaunch: () => vi.fn(async () => preparation),
      startAgentRun: vi.fn(),
      notify: vi.fn()
    })

    await expect(spawner.spawn('/definitely/missing', 'Bug Hunter', 'go')).rejects.toThrow(
      'project path does not exist'
    )
    const projectPath = mkdtempSync(path.join(tmpdir(), 'dobius-spawn-'))
    await expect(spawner.spawn(projectPath, 'missing', 'go')).rejects.toThrow('agent not found')
  })
})

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { CustomAgent } from '../../shared/agents'
import type { PrepareClaudeLaunch } from '../agents/agent-runner'

export type ConductorAgentSpawnerDeps = {
  listAgents(): CustomAgent[]
  getPrepareClaudeLaunch(): PrepareClaudeLaunch | null
  startAgentRun(args: {
    agentId: string
    prompt: string
    cwd: string
    prepareClaudeLaunch: PrepareClaudeLaunch
    options: {
      source: 'channel'
      resume: false
      onResult(message: { subtype: string; result?: string; errors?: string[] }): void
      onRunEnded(status: 'error' | 'cancelled', summary: string): void
    }
  }): Promise<string>
  notify(message: string): Promise<void>
}

function findAgent(agentId: string, agents: readonly CustomAgent[]): CustomAgent | null {
  const query = agentId.trim().toLowerCase()
  return (
    agents.find((agent) => agent.id === agentId) ??
    agents.find((agent) => agent.name.toLowerCase() === query) ??
    agents.find((agent) => agent.name.toLowerCase().includes(query)) ??
    null
  )
}

function validateProjectPath(projectPath: string): string {
  const resolved = path.resolve(projectPath.trim())
  if (!projectPath.trim() || projectPath.includes('\u0000')) {
    throw new Error('projectPath required')
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`project path does not exist: ${resolved}`)
  }
  return resolved
}

export function createConductorAgentSpawner(deps: ConductorAgentSpawnerDeps): {
  spawn(projectPath: string, agentId: string, prompt: string): Promise<{ runId: string }>
} {
  return {
    async spawn(projectPath, agentId, prompt) {
      const cwd = validateProjectPath(projectPath)
      const agent = findAgent(agentId, deps.listAgents())
      if (!agent) {
        throw new Error(`agent not found: ${agentId}`)
      }
      const trimmedPrompt = prompt.trim()
      if (!trimmedPrompt) {
        throw new Error('initialPrompt required')
      }
      const prepareClaudeLaunch = deps.getPrepareClaudeLaunch()
      if (!prepareClaudeLaunch) {
        throw new Error('Claude launch preparation is unavailable')
      }
      let reported = false
      const report = (message: string): void => {
        if (reported) {return}
        reported = true
        void deps.notify(message).catch((error) => {
          console.warn('[voice-conductor] failed to report spawned agent result:', error)
        })
      }
      const runId = await deps.startAgentRun({
        agentId: agent.id,
        prompt: trimmedPrompt,
        cwd,
        prepareClaudeLaunch,
        options: {
          source: 'channel',
          // Why: dobius-spawn promises a fresh worker; resuming the agent's prior
          // conversation could carry unrelated project context into this task.
          resume: false,
          onResult: (message) => {
            if (message.subtype === 'success') {
              report(`${agent.name} finished: ${(message.result ?? 'Completed').slice(0, 500)}`)
            } else {
              report(`${agent.name} failed: ${(message.errors ?? ['Unknown error']).join('; ').slice(0, 500)}`)
            }
          },
          onRunEnded: (status, summary) => report(`${agent.name} ${status}: ${summary.slice(0, 500)}`)
        }
      })
      return { runId }
    }
  }
}

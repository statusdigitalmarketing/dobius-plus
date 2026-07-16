import type { AgentRun, CustomAgent } from '../shared/agents'

export function formatAgentList(result: { agents: CustomAgent[] }): string {
  if (result.agents.length === 0) {
    return 'No agents found.'
  }
  return result.agents
    .map(
      (agent) =>
        `${agent.id}  ${agent.name}  ${agent.model}\n${agent.description || '(no description)'}`
    )
    .join('\n\n')
}

export function formatAgentShow(result: { agent: CustomAgent | undefined }): string {
  const agent = result.agent
  if (!agent) {
    return 'Agent not found.'
  }
  return [
    `id: ${agent.id}`,
    `name: ${agent.name}`,
    `description: ${agent.description || '(none)'}`,
    `model: ${agent.model}`,
    `tools: ${agent.allowedTools.join(', ')}`,
    `skills: ${agent.skills.join(', ') || 'none'}`,
    `cwd: ${agent.cwd || '(default)'}`,
    `bypassPermissions: ${agent.bypassPermissions}`,
    `lastSessionId: ${agent.lastSessionId ?? 'null'}`,
    `createdAt: ${new Date(agent.createdAt).toISOString()}`,
    `updatedAt: ${new Date(agent.updatedAt).toISOString()}`,
    `systemPrompt:\n${agent.systemPrompt || '(none)'}`
  ].join('\n')
}

export function formatAgentRemoved(result: { removed: boolean; id: string }): string {
  return result.removed ? `Removed agent ${result.id}.` : `Agent ${result.id} not removed.`
}

export function formatAgentRunStarted(result: { runId: string }): string {
  return `Started agent run ${result.runId}. Use \`agents runs\` to check its status.`
}

export function formatAgentRuns(result: { runs: AgentRun[] }): string {
  if (result.runs.length === 0) {
    return 'No agent runs found.'
  }
  return result.runs
    .map(
      (run) =>
        `${run.id}  ${run.agentId}  ${run.status}  ${new Date(run.startedAt).toISOString()}${
          run.summary ? `\n${run.summary}` : ''
        }`
    )
    .join('\n\n')
}

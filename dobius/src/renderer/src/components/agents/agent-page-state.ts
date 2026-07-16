import type {
  AgentChannels,
  AgentHeartbeatSettings,
  AgentNotifyLevel,
  CustomAgent,
  CustomAgentInput
} from '../../../../shared/agents'

export const AGENT_MODELS = [
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-haiku-4-5'
]

export const AGENT_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch'
]

export const TRANSCRIPT_LIMIT = 500

export type AgentPageMode = 'run' | 'memory'

export type AgentDraft = Omit<
  CustomAgentInput,
  'heartbeat' | 'notify' | 'channels' | 'cwd' | 'skills'
> & {
  id?: string
  cwd: string
  skills: string[]
  heartbeat: AgentHeartbeatSettings
  notify: AgentNotifyLevel
  channels: AgentChannels
}

export function agentToDraft(agent: CustomAgent | null): AgentDraft {
  if (!agent) {
    return {
      name: '',
      description: '',
      icon: 'bot',
      color: '#b9bcc2',
      systemPrompt: '',
      model: AGENT_MODELS[0],
      allowedTools: ['Read', 'Grep', 'Glob'],
      skills: [],
      cwd: '',
      bypassPermissions: false,
      heartbeat: {
        enabled: false,
        frequency: 'daily',
        at: '08:00',
        quietStart: '23:00',
        quietEnd: '08:00',
        maxBudgetUsd: 0.5,
        maxTurns: 25
      },
      notify: 'digest + urgent',
      channels: { imessage: false }
    }
  }
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    color: agent.color,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    allowedTools: [...agent.allowedTools],
    skills: [...agent.skills],
    cwd: agent.cwd,
    bypassPermissions: agent.bypassPermissions,
    heartbeat: { ...agent.heartbeat },
    notify: agent.notify,
    channels: { ...agent.channels }
  }
}

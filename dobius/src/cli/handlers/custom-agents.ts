import type { AgentRun, CustomAgent } from '../../shared/agents'
import type { CommandHandler } from '../dispatch'
import {
  formatAgentList,
  formatAgentRemoved,
  formatAgentRuns,
  formatAgentRunStarted,
  formatAgentShow,
  printResult
} from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'

function getCommaListFlag(
  flags: Map<string, string | boolean>,
  name: string
): string[] | undefined {
  const raw = getOptionalStringFlag(flags, name)
  if (raw === undefined) {
    return undefined
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function collectAgentFields(flags: Map<string, string | boolean>): {
  description?: string
  systemPrompt?: string
  model?: string
  allowedTools?: string[]
  skills?: string[]
  cwd?: string
} {
  return {
    description: getOptionalStringFlag(flags, 'description'),
    systemPrompt: getOptionalStringFlag(flags, 'system-prompt'),
    model: getOptionalStringFlag(flags, 'model'),
    allowedTools: getCommaListFlag(flags, 'tools'),
    skills: getCommaListFlag(flags, 'skills'),
    cwd: getOptionalStringFlag(flags, 'cwd')
  }
}

export const CUSTOM_AGENT_HANDLERS: Record<string, CommandHandler> = {
  'agents list': async ({ client, json }) => {
    const result = await client.call<{ agents: CustomAgent[] }>('agent.list')
    printResult(result, json, formatAgentList)
  },
  'agents show': async ({ flags, client, json }) => {
    const result = await client.call<{ agent: CustomAgent }>('agent.show', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatAgentShow)
  },
  'agents create': async ({ flags, client, json }) => {
    const result = await client.call<{ agent: CustomAgent }>('agent.create', {
      name: getRequiredStringFlag(flags, 'name'),
      ...collectAgentFields(flags)
    })
    printResult(result, json, formatAgentShow)
  },
  'agents edit': async ({ flags, client, json }) => {
    const result = await client.call<{ agent: CustomAgent }>('agent.update', {
      id: getRequiredStringFlag(flags, 'id'),
      updates: {
        name: getOptionalStringFlag(flags, 'name'),
        ...collectAgentFields(flags)
      }
    })
    printResult(result, json, formatAgentShow)
  },
  'agents remove': async ({ flags, client, json }) => {
    const result = await client.call<{ removed: boolean; id: string }>('agent.delete', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatAgentRemoved)
  },
  'agents run': async ({ flags, client, json }) => {
    const result = await client.call<{ runId: string }>('agent.run', {
      id: getRequiredStringFlag(flags, 'id'),
      prompt: getRequiredStringFlag(flags, 'prompt')
    })
    printResult(result, json, formatAgentRunStarted)
  },
  'agents runs': async ({ flags, client, json }) => {
    const result = await client.call<{ runs: AgentRun[] }>('agent.runs', {
      agentId: getOptionalStringFlag(flags, 'id')
    })
    printResult(result, json, formatAgentRuns)
  }
}

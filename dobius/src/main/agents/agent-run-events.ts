import { BrowserWindow } from 'electron'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentRunEvent } from '../../shared/agents'

export function broadcastRunEvent(event: AgentRunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('agents:runEvent', event)
    }
  }
}

export function broadcastRunsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('agents:runsChanged')
    }
  }
}

export function eventBase(
  runId: string,
  agentId: string
): Pick<AgentRunEvent, 'runId' | 'agentId' | 'ts'> {
  return { runId, agentId, ts: Date.now() }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined) {
    return ''
  }
  try {
    return JSON.stringify(value)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function reduceAssistantMessage(
  message: SDKMessage,
  runId: string,
  agentId: string
): AgentRunEvent[] {
  if (message.type !== 'assistant') {
    return []
  }
  const events: AgentRunEvent[] = []
  if (message.error) {
    events.push({ ...eventBase(runId, agentId), kind: 'error', text: message.error })
  }
  for (const block of message.message.content) {
    if (typeof block !== 'object' || block === null || !('type' in block)) {
      continue
    }
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      events.push({ ...eventBase(runId, agentId), kind: 'assistant-text', text: block.text })
    } else if (block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
      events.push({
        ...eventBase(runId, agentId),
        kind: 'tool-use',
        toolName: block.name,
        detail: 'input' in block ? describeValue(block.input) : ''
      })
    }
  }
  return events
}

function reduceToolResultMessage(
  message: SDKMessage,
  runId: string,
  agentId: string
): AgentRunEvent[] {
  if (message.type !== 'user' || !message.message || !('content' in message.message)) {
    return []
  }
  const content = message.message.content
  if (!Array.isArray(content)) {
    return []
  }
  return content.flatMap((block) => {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'tool_result'
    ) {
      return [
        {
          ...eventBase(runId, agentId),
          kind: 'tool-result' as const,
          detail: 'content' in block ? describeValue(block.content) : ''
        }
      ]
    }
    return []
  })
}

export function reduceMessage(
  message: SDKMessage,
  runId: string,
  agentId: string
): AgentRunEvent[] {
  switch (message.type) {
    case 'assistant':
      return reduceAssistantMessage(message, runId, agentId)
    case 'user':
      return reduceToolResultMessage(message, runId, agentId)
    case 'result':
      return [
        {
          ...eventBase(runId, agentId),
          kind: message.subtype === 'success' ? 'result' : 'error',
          text: message.subtype === 'success' ? message.result : message.errors.join('\n'),
          detail: message.subtype
        }
      ]
    case 'system':
      if (message.subtype === 'init') {
        return [
          {
            ...eventBase(runId, agentId),
            kind: 'system',
            detail: `Initialized ${message.model} in ${message.cwd}`
          }
        ]
      }
      if (message.subtype === 'permission_denied') {
        return [
          {
            ...eventBase(runId, agentId),
            kind: 'error',
            toolName: message.tool_name,
            text: `Permission denied for ${message.tool_name}`
          }
        ]
      }
      return []
    case 'tool_progress':
      return [
        {
          ...eventBase(runId, agentId),
          kind: 'tool-use',
          toolName: message.tool_name,
          detail: `${Math.round(message.elapsed_time_seconds)}s`
        }
      ]
    case 'tool_use_summary':
      return [{ ...eventBase(runId, agentId), kind: 'tool-result', detail: message.summary }]
    default:
      return []
  }
}

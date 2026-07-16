import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { TriageVerdict } from '../../shared/agents'

export function triageOutputFormat(): Options['outputFormat'] {
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['actionable', 'skill', 'summary', 'needsClarification'],
      properties: {
        actionable: { type: 'boolean' },
        skill: { type: 'string' },
        summary: { type: 'string' },
        needsClarification: { type: 'boolean' }
      }
    }
  }
}

export function validateTriageVerdict(value: unknown): TriageVerdict | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Partial<Record<keyof TriageVerdict, unknown>>
  if (
    typeof record.actionable !== 'boolean' ||
    typeof record.skill !== 'string' ||
    typeof record.summary !== 'string' ||
    typeof record.needsClarification !== 'boolean'
  ) {
    return null
  }
  return {
    actionable: record.actionable,
    skill: record.skill.trim(),
    summary: record.summary.trim(),
    needsClarification: record.needsClarification
  }
}

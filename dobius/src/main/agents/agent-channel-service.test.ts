import { describe, expect, it } from 'vitest'
import type { CustomAgent } from '../../shared/agents'
import { matchAgentMention } from './agent-channel-service'

function agent(overrides: Partial<CustomAgent>): CustomAgent {
  return {
    id: overrides.id ?? overrides.name ?? 'agent',
    name: overrides.name ?? 'Auditor',
    description: '',
    icon: 'bot',
    color: '#b9bcc2',
    systemPrompt: '',
    model: 'claude-opus-4-8',
    allowedTools: ['Read', 'Grep', 'Glob'],
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
    channels: { imessage: true },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
    skills: overrides.skills ?? []
  }
}

describe('matchAgentMention', () => {
  it('matches @Auditor with an ask', () => {
    expect(
      matchAgentMention('@Auditor check the diff', [agent({ name: 'Auditor' })])
    ).toMatchObject({
      agent: { name: 'Auditor' },
      ask: 'check the diff'
    })
  })

  it('matches case-insensitively', () => {
    expect(matchAgentMention('@auditor check', [agent({ name: 'Auditor' })])).toMatchObject({
      agent: { name: 'Auditor' },
      ask: 'check'
    })
  })

  it('matches spaced names and compact aliases', () => {
    const sentry = agent({ name: 'Sentry Watch' })
    expect(matchAgentMention('@Sentry Watch check errors', [sentry])).toMatchObject({
      agent: { name: 'Sentry Watch' },
      ask: 'check errors'
    })
    expect(matchAgentMention('@sentrywatch', [sentry])).toMatchObject({
      agent: { name: 'Sentry Watch' },
      ask: 'Report your current status briefly.'
    })
  })

  it('returns null for non-mentions', () => {
    expect(matchAgentMention('Auditor check', [agent({ name: 'Auditor' })])).toBeNull()
  })

  it('returns unknown-mention for missing eligible agents', () => {
    expect(matchAgentMention('@nobody check', [agent({ name: 'Auditor' })])).toBe('unknown-mention')
  })

  it('does not match agents without iMessage enabled', () => {
    expect(
      matchAgentMention('@Auditor check', [
        agent({ name: 'Auditor', channels: { imessage: false } })
      ])
    ).toBe('unknown-mention')
  })
})

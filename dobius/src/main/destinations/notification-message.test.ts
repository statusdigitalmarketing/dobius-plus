import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import {
  extractNotifyBlock,
  isFailureStatus,
  renderAutomationNotification
} from './notification-message'

function runFixture(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Nightly audit',
    scheduledFor: 1_000,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 10_000,
    dispatchedAt: 25_000,
    createdAt: 1_000,
    ...overrides
  }
}

function snapshot(content: string): AutomationRun['outputSnapshot'] {
  return { format: 'plain_text', content, capturedAt: 30_000, truncated: false }
}

describe('extractNotifyBlock', () => {
  it('returns the text after the NOTIFY: marker', () => {
    expect(extractNotifyBlock('lots of noise\nNOTIFY: 3 findings, none critical')).toBe(
      '3 findings, none critical'
    )
  })

  it('returns null when no marker exists', () => {
    expect(extractNotifyBlock('plain terminal output')).toBeNull()
  })

  it('returns null for an empty marker', () => {
    expect(extractNotifyBlock('done\nNOTIFY:   ')).toBeNull()
  })
})

describe('isFailureStatus', () => {
  it('treats completed as success and everything else as failure', () => {
    expect(isFailureStatus('completed')).toBe(false)
    expect(isFailureStatus('dispatch_failed')).toBe(true)
    expect(isFailureStatus('skipped_precheck')).toBe(true)
  })
})

describe('renderAutomationNotification', () => {
  it('ping depth emits only the status line with duration', () => {
    const message = renderAutomationNotification('Nightly audit', runFixture(), 'ping')
    expect(message.title).toBe('Nightly audit: completed in 15s')
    expect(message.body).toBe('')
  })

  it('brief depth prefers the NOTIFY block and truncates it', () => {
    const run = runFixture({ outputSnapshot: snapshot(`noise\nNOTIFY: ${'x'.repeat(400)}`) })
    const message = renderAutomationNotification('Nightly audit', run, 'brief')
    expect(message.body.length).toBe(300)
    expect(message.body.endsWith('…')).toBe(true)
  })

  it('full depth falls back to raw output when no NOTIFY block exists', () => {
    const run = runFixture({ outputSnapshot: snapshot('  raw output tail  ') })
    const message = renderAutomationNotification('Nightly audit', run, 'full')
    expect(message.body).toBe('raw output tail')
  })

  it('failure status lands in the title with the error', () => {
    const run = runFixture({ status: 'dispatch_failed', error: 'target offline' })
    const message = renderAutomationNotification('Nightly audit', run, 'ping')
    expect(message.title).toBe('Nightly audit: failed in 15s — target offline')
  })
})

import { describe, it, expect, vi } from 'vitest'

// Stub the agent modules so importing conductor.ts does not pull in the
// electron / SDK chain — this test only exercises the pure reply-store logic.
vi.mock('../agents/agents-store', () => ({
  createAgent: vi.fn(),
  listAgents: vi.fn(() => [])
}))
vi.mock('../agents/agent-runner', () => ({
  startAgentRun: vi.fn(),
  stopAgentRun: vi.fn()
}))
vi.mock('../agents/default-claude-launch', () => ({
  getDefaultPrepareClaudeLaunch: () => null
}))

import { createReplyStore, createVoiceConductor } from './conductor'

describe('Voice Conductor enable gate', () => {
  it('rejects transcripts while the conductor is disabled', async () => {
    const conductor = createVoiceConductor()

    await expect(
      conductor.postTranscript({ requestId: 'req-1', transcript: 'start work' })
    ).rejects.toThrow('Voice Conductor is disabled')
  })
})

describe('createReplyStore', () => {
  it('returns the stored reply when no sinceTs is given', () => {
    const store = createReplyStore(() => 100)
    store.set('req-1', 'done')
    expect(store.get('req-1')).toEqual({ message: 'done', ts: 100 })
  })

  it('returns null for an unknown requestId', () => {
    const store = createReplyStore(() => 1)
    expect(store.get('missing')).toBeNull()
  })

  it('returns null when the reply is not strictly newer than sinceTs', () => {
    const store = createReplyStore(() => 50)
    store.set('req-1', 'old')
    // Equal timestamp is not "newer" — poll should keep waiting.
    expect(store.get('req-1', 50)).toBeNull()
    // Older than sinceTs is also withheld.
    expect(store.get('req-1', 60)).toBeNull()
  })

  it('returns the reply when it is newer than sinceTs', () => {
    const store = createReplyStore(() => 200)
    store.set('req-1', 'fresh')
    expect(store.get('req-1', 100)).toEqual({ message: 'fresh', ts: 200 })
  })

  it('overwrites an earlier reply for the same requestId with a new timestamp', () => {
    let clock = 10
    const store = createReplyStore(() => clock)
    store.set('req-1', 'first')
    clock = 20
    store.set('req-1', 'second')
    expect(store.get('req-1')).toEqual({ message: 'second', ts: 20 })
    // The refreshed timestamp is visible to a caller that had seen the first reply.
    expect(store.get('req-1', 15)).toEqual({ message: 'second', ts: 20 })
  })

  it('tracks distinct requestIds independently', () => {
    let clock = 1
    const store = createReplyStore(() => clock)
    store.set('req-a', 'a')
    clock = 2
    store.set('req-b', 'b')
    expect(store.get('req-a')).toEqual({ message: 'a', ts: 1 })
    expect(store.get('req-b')).toEqual({ message: 'b', ts: 2 })
  })
})

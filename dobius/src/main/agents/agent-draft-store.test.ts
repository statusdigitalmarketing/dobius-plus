import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
  send: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userDataDir)
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { send: electronMock.send }
      }
    ])
  }
}))

async function loadStore() {
  vi.resetModules()
  return import('./agent-draft-store')
}

beforeEach(() => {
  electronMock.userDataDir = mkdtempSync(path.join(tmpdir(), 'dobius-agent-drafts-'))
  electronMock.send.mockClear()
})

afterEach(() => {
  rmSync(electronMock.userDataDir, { recursive: true, force: true })
})

describe('agent draft store', () => {
  it('appends and lists pending drafts first', async () => {
    const store = await loadStore()
    const draft = store.appendDraft({
      agentId: 'agent-1',
      target: { kind: 'asana', gid: '120' },
      body: 'Ready to post'
    })
    expect(draft).toMatchObject({
      agentId: 'agent-1',
      target: { kind: 'asana', gid: '120' },
      body: 'Ready to post',
      status: 'pending'
    })
    expect(store.listDrafts()).toHaveLength(1)
    expect(electronMock.send).toHaveBeenCalledWith('agents:draftsChanged')
  })

  it('updates draft status and returns recent finalized drafts', async () => {
    const store = await loadStore()
    const draft = store.appendDraft({
      agentId: 'agent-1',
      target: { kind: 'asana', gid: '121' },
      body: 'Discard me'
    })
    expect(store.setDraftStatus(draft.id, 'discarded')).toMatchObject({ status: 'discarded' })
    expect(store.getDraft(draft.id)).toMatchObject({ status: 'discarded' })
    expect(store.listDrafts()[0]).toMatchObject({ status: 'discarded' })
  })

  it('caps persisted drafts at 100', async () => {
    const store = await loadStore()
    for (let index = 0; index < 105; index += 1) {
      store.appendDraft({
        agentId: 'agent-1',
        target: { kind: 'asana', gid: String(index) },
        body: `draft ${index}`
      })
    }
    const drafts = store.listDrafts()
    expect(drafts).toHaveLength(100)
    expect(drafts.some((draft) => draft.target.gid === '0')).toBe(false)
    expect(drafts.some((draft) => draft.target.gid === '104')).toBe(true)
  })
})

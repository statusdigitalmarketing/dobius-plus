import type { AgentDraftComment } from '../../shared/agents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  setDraftStatus: vi.fn(),
  hasAsanaToken: vi.fn(),
  postTaskComment: vi.fn()
}))

vi.mock('./agent-draft-store', () => ({
  getDraft: mocks.getDraft,
  setDraftStatus: mocks.setDraftStatus
}))

vi.mock('../asana/asana-token-store', () => ({
  hasAsanaToken: mocks.hasAsanaToken
}))

vi.mock('../asana/asana-client', () => ({
  postTaskComment: mocks.postTaskComment
}))

const pendingDraft: AgentDraftComment = {
  id: 'draft-1',
  agentId: 'agent-1',
  target: { kind: 'asana', gid: '123456' },
  body: 'Looks good',
  createdAt: 1,
  status: 'pending'
}

beforeEach(() => {
  vi.resetModules()
  mocks.getDraft.mockReset()
  mocks.setDraftStatus.mockReset()
  mocks.hasAsanaToken.mockReset()
  mocks.postTaskComment.mockReset()
  mocks.getDraft.mockReturnValue(pendingDraft)
  mocks.hasAsanaToken.mockReturnValue(true)
  mocks.postTaskComment.mockResolvedValue({ gid: 'story-1' })
  mocks.setDraftStatus.mockReturnValue({ ...pendingDraft, status: 'approved' })
})

describe('approveDraftAndPost', () => {
  it('posts a pending draft and marks it approved', async () => {
    const { approveDraftAndPost } = await import('./agent-draft-approval')
    await expect(approveDraftAndPost('draft-1')).resolves.toMatchObject({ status: 'approved' })
    expect(mocks.postTaskComment).toHaveBeenCalledTimes(1)
    expect(mocks.postTaskComment).toHaveBeenCalledWith('123456', 'Looks good')
    expect(mocks.setDraftStatus).toHaveBeenCalledWith('draft-1', 'approved')
  })

  it('rejects missing drafts without posting or changing status', async () => {
    mocks.getDraft.mockReturnValue(null)
    const { approveDraftAndPost } = await import('./agent-draft-approval')
    await expect(approveDraftAndPost('missing')).rejects.toThrow('Draft not found')
    expect(mocks.postTaskComment).not.toHaveBeenCalled()
    expect(mocks.setDraftStatus).not.toHaveBeenCalled()
  })

  it('rejects non-pending drafts without posting or changing status', async () => {
    mocks.getDraft.mockReturnValue({ ...pendingDraft, status: 'discarded' })
    const { approveDraftAndPost } = await import('./agent-draft-approval')
    await expect(approveDraftAndPost('draft-1')).rejects.toThrow(
      'Only pending drafts can be approved'
    )
    expect(mocks.postTaskComment).not.toHaveBeenCalled()
    expect(mocks.setDraftStatus).not.toHaveBeenCalled()
  })

  it('rejects disconnected Asana without posting or changing status', async () => {
    mocks.hasAsanaToken.mockReturnValue(false)
    const { approveDraftAndPost } = await import('./agent-draft-approval')
    await expect(approveDraftAndPost('draft-1')).rejects.toThrow('Asana not connected')
    expect(mocks.postTaskComment).not.toHaveBeenCalled()
    expect(mocks.setDraftStatus).not.toHaveBeenCalled()
  })

  it('leaves a draft pending when posting fails', async () => {
    mocks.postTaskComment.mockRejectedValue(new Error('Asana HTTP 500'))
    const { approveDraftAndPost } = await import('./agent-draft-approval')
    await expect(approveDraftAndPost('draft-1')).rejects.toThrow(
      'Could not post draft to Asana: Asana HTTP 500'
    )
    expect(mocks.setDraftStatus).not.toHaveBeenCalled()
  })

  it('rejects a concurrent second approve of the same draft (no double post)', async () => {
    let resolvePost: (v: { gid: string }) => void = () => {}
    mocks.postTaskComment.mockReturnValue(
      new Promise<{ gid: string }>((r) => {
        resolvePost = r
      })
    )
    const { approveDraftAndPost } = await import('./agent-draft-approval')
    const first = approveDraftAndPost('draft-1')
    await expect(approveDraftAndPost('draft-1')).rejects.toThrow('already being posted')
    resolvePost({ gid: 'story-1' })
    await first
    expect(mocks.postTaskComment).toHaveBeenCalledTimes(1)
  })
})

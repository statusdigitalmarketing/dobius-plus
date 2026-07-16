import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../voice-conductor/service', () => ({
  postVoiceConductorTranscript: vi.fn(),
  getVoiceConductorReply: vi.fn()
}))

import {
  getVoiceConductorReply,
  postVoiceConductorTranscript
} from '../../../voice-conductor/service'
import { RpcDispatcher } from '../dispatcher'
import { VOICE_CONDUCTOR_METHODS } from './voice-conductor'

function dispatcher(): RpcDispatcher {
  return new RpcDispatcher({
    runtime: { getRuntimeId: () => 'test-runtime' } as never,
    methods: VOICE_CONDUCTOR_METHODS
  })
}

describe('Voice Conductor RPC methods', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a tagged voice transcript', async () => {
    vi.mocked(postVoiceConductorTranscript).mockResolvedValue()

    await expect(
      dispatcher().dispatch({ id: '1', authToken: 'test', method: 'voice.intent', params: {
        requestId: 'req-1234',
        transcript: 'Check the build'
      } })
    ).resolves.toMatchObject({ ok: true, result: { accepted: true, requestId: 'req-1234' } })
    expect(postVoiceConductorTranscript).toHaveBeenCalledWith({
      requestId: 'req-1234',
      transcript: 'Check the build'
    })
  })

  it('returns a reply newer than the caller timestamp', async () => {
    vi.mocked(getVoiceConductorReply).mockReturnValue({ message: 'On it', ts: 20 })

    await expect(
      dispatcher().dispatch({
        id: '2',
        authToken: 'test',
        method: 'voice.reply',
        params: { requestId: 'req-1234', sinceTs: 10 }
      })
    ).resolves.toMatchObject({ ok: true, result: { reply: { message: 'On it', ts: 20 } } })
    expect(getVoiceConductorReply).toHaveBeenCalledWith('req-1234', 10)
  })

  it('rejects malformed request ids before dispatch', async () => {
    await expect(
      dispatcher().dispatch({
        id: '3',
        authToken: 'test',
        method: 'voice.intent',
        params: { requestId: '../bad', transcript: 'hello' }
      })
    ).resolves.toMatchObject({ ok: false })
    expect(postVoiceConductorTranscript).not.toHaveBeenCalled()
  })
})

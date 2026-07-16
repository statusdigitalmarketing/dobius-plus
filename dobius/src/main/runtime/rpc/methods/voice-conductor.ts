import { z } from 'zod'
import {
  getVoiceConductorReply,
  postVoiceConductorTranscript
} from '../../../voice-conductor/service'
import { defineMethod, type RpcMethod } from '../core'

const RequestId = z.string().trim().min(4).max(80).regex(/^[a-zA-Z0-9-]+$/)

const VoiceIntent = z.object({
  requestId: RequestId,
  transcript: z.string().trim().min(1).max(16_000)
})

const VoiceReply = z.object({
  requestId: RequestId,
  sinceTs: z.number().finite().nonnegative().optional()
})

export const VOICE_CONDUCTOR_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'voice.intent',
    params: VoiceIntent,
    handler: async (params) => {
      await postVoiceConductorTranscript(params)
      return { accepted: true, requestId: params.requestId }
    }
  }),
  defineMethod({
    name: 'voice.reply',
    params: VoiceReply,
    handler: (params) => ({
      reply: getVoiceConductorReply(params.requestId, params.sinceTs)
    })
  })
]

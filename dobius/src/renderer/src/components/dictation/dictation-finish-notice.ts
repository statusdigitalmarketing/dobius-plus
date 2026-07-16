export type DictationFinishNotice = 'no-speech' | 'hold-mode-hint' | null

// Why: in hold mode a quick TAP of the dictation shortcut starts and stops
// before any audio is captured, which used to end the session with zero
// feedback — indistinguishable from "voice is broken". Surface a hint instead.
export function resolveDictationFinishNotice(opts: {
  sessionErrored: boolean
  finalTranscriptReceived: boolean
  capturedChunkCount: number
  dictationMode: 'toggle' | 'hold'
}): DictationFinishNotice {
  if (opts.sessionErrored || opts.finalTranscriptReceived) {
    return null
  }
  if (opts.capturedChunkCount > 0) {
    return 'no-speech'
  }
  return opts.dictationMode === 'hold' ? 'hold-mode-hint' : null
}

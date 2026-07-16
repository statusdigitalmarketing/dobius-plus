import { describe, expect, it } from 'vitest'
import { resolveDictationFinishNotice } from './dictation-finish-notice'

describe('resolveDictationFinishNotice', () => {
  it('returns hold-mode-hint for a silent tap in hold mode', () => {
    expect(
      resolveDictationFinishNotice({
        sessionErrored: false,
        finalTranscriptReceived: false,
        capturedChunkCount: 0,
        dictationMode: 'hold'
      })
    ).toBe('hold-mode-hint')
  })

  it('stays silent for a zero-capture stop in toggle mode', () => {
    expect(
      resolveDictationFinishNotice({
        sessionErrored: false,
        finalTranscriptReceived: false,
        capturedChunkCount: 0,
        dictationMode: 'toggle'
      })
    ).toBeNull()
  })

  it('returns no-speech when audio was captured but nothing transcribed', () => {
    expect(
      resolveDictationFinishNotice({
        sessionErrored: false,
        finalTranscriptReceived: false,
        capturedChunkCount: 3,
        dictationMode: 'hold'
      })
    ).toBe('no-speech')
  })

  it('stays silent when a transcript was delivered or the session errored', () => {
    expect(
      resolveDictationFinishNotice({
        sessionErrored: false,
        finalTranscriptReceived: true,
        capturedChunkCount: 3,
        dictationMode: 'hold'
      })
    ).toBeNull()
    expect(
      resolveDictationFinishNotice({
        sessionErrored: true,
        finalTranscriptReceived: false,
        capturedChunkCount: 0,
        dictationMode: 'hold'
      })
    ).toBeNull()
  })
})

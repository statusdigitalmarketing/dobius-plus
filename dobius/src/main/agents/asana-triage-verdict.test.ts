import { describe, expect, it } from 'vitest'
import { triageOutputFormat, validateTriageVerdict } from './asana-triage-verdict'

describe('triage verdict schema', () => {
  it('declares the required structured output fields', () => {
    expect(triageOutputFormat()).toMatchObject({
      type: 'json_schema',
      schema: {
        additionalProperties: false,
        required: ['actionable', 'skill', 'summary', 'needsClarification']
      }
    })
  })

  it('validates and trims structured triage verdicts', () => {
    expect(
      validateTriageVerdict({
        actionable: true,
        skill: ' review-audit ',
        summary: ' Check the patch ',
        needsClarification: false
      })
    ).toEqual({
      actionable: true,
      skill: 'review-audit',
      summary: 'Check the patch',
      needsClarification: false
    })
  })

  it('rejects malformed verdicts', () => {
    expect(
      validateTriageVerdict({ actionable: true, skill: '', summary: 'missing flag' })
    ).toBeNull()
  })
})

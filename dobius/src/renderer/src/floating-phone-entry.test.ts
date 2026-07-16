import { describe, expect, it } from 'vitest'
import { normalizeFloatingPhoneUrlInput, parseFloatingPhoneHash } from './floating-phone-entry'

describe('parseFloatingPhoneHash', () => {
  it('parses app mode with a worktree', () => {
    expect(parseFloatingPhoneHash('#phone-visual=1&mode=app&worktree=wt-1')).toEqual({
      mode: 'app',
      worktreeId: 'wt-1',
      url: null
    })
  })

  it('parses web mode with an http url', () => {
    expect(
      parseFloatingPhoneHash('#phone-visual=1&mode=web&url=http%3A%2F%2Flocalhost%3A3000')
    ).toEqual({
      mode: 'web',
      worktreeId: null,
      url: 'http://localhost:3000/'
    })
  })

  it('rejects missing marker or mode', () => {
    expect(parseFloatingPhoneHash('#mode=web')).toBeNull()
    expect(parseFloatingPhoneHash('#phone-visual=1')).toBeNull()
  })

  it('rejects bad modes and unsafe url schemes', () => {
    expect(parseFloatingPhoneHash('#phone-visual=1&mode=desktop')).toBeNull()
    expect(parseFloatingPhoneHash('#phone-visual=1&mode=web&url=javascript%3Aalert(1)')).toBeNull()
    expect(
      parseFloatingPhoneHash('#phone-visual=1&mode=web&url=file%3A%2F%2F%2Ftmp%2Fa')
    ).toBeNull()
  })
})

describe('normalizeFloatingPhoneUrlInput', () => {
  it('adds https when a scheme is missing', () => {
    expect(normalizeFloatingPhoneUrlInput('example.com/path')).toBe('https://example.com/path')
  })

  it('keeps explicit http and https urls', () => {
    expect(normalizeFloatingPhoneUrlInput('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeFloatingPhoneUrlInput('https://example.com')).toBe('https://example.com/')
  })

  it('rejects unsafe schemes', () => {
    expect(normalizeFloatingPhoneUrlInput('javascript:alert(1)')).toBeNull()
    expect(normalizeFloatingPhoneUrlInput('file:///tmp/a')).toBeNull()
  })
})

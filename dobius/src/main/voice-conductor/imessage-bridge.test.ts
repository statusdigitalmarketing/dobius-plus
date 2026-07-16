import { describe, expect, it } from 'vitest'
import { createIMessageBridge } from './imessage-bridge'

// These tests exercise the pure platform gate only. Injecting `platform` via
// config keeps them hermetic — no real chat.db read and no osascript send, so
// they run identically on macOS, Linux, and CI.

describe('createIMessageBridge platform gate', () => {
  it('isAvailable() is false when platform is not darwin', () => {
    const bridge = createIMessageBridge({ handle: 'carson@example.com', platform: 'linux' })
    expect(bridge.isAvailable()).toBe(false)
  })

  it('isAvailable() is false on win32', () => {
    const bridge = createIMessageBridge({ handle: 'carson@example.com', platform: 'win32' })
    expect(bridge.isAvailable()).toBe(false)
  })

  it('isAvailable() is true on darwin', () => {
    const bridge = createIMessageBridge({ handle: 'carson@example.com', platform: 'darwin' })
    expect(bridge.isAvailable()).toBe(true)
  })

  it('send() rejects on non-darwin without touching osascript', async () => {
    const bridge = createIMessageBridge({ handle: 'carson@example.com', platform: 'linux' })
    await expect(bridge.send('hello')).rejects.toThrow(/macOS only/)
  })

  it('ask() rejects on non-darwin without opening chat.db', async () => {
    const bridge = createIMessageBridge({
      handle: 'carson@example.com',
      platform: 'linux',
      // A bogus db path proves the platform gate rejects BEFORE any DB open.
      chatDbPath: '/nonexistent/chat.db'
    })
    await expect(bridge.ask('are you there?', 1_000)).rejects.toThrow(/macOS only/)
  })
})

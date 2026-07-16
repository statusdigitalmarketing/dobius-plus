import { describe, expect, it, vi } from 'vitest'

const hasLivePty = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }))
  }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

vi.mock('../ipc/pty', () => ({
  hasLivePty,
  killPty: vi.fn()
}))

describe('validateTearOffTerminalRequest', () => {
  it('rejects invalid tab ids', async () => {
    const { validateTearOffTerminalRequest } = await import('./tear-off-window')
    hasLivePty.mockReturnValue(true)
    expect(validateTearOffTerminalRequest({ tabId: 'bad:tab', ptyId: 'pty-1' })).toBe(false)
  })

  it('rejects dead pty ids', async () => {
    const { validateTearOffTerminalRequest } = await import('./tear-off-window')
    hasLivePty.mockReturnValue(false)
    expect(validateTearOffTerminalRequest({ tabId: 'tab-1', ptyId: 'pty-1' })).toBe(false)
  })

  it('accepts valid tab ids with live ptys', async () => {
    const { validateTearOffTerminalRequest } = await import('./tear-off-window')
    hasLivePty.mockReturnValue(true)
    expect(validateTearOffTerminalRequest({ tabId: 'tab-1', ptyId: 'pty-1' })).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'

import { applyLaunchAtLogin, shouldRegisterLoginItem } from './launch-at-login'

describe('shouldRegisterLoginItem', () => {
  it('registers only for the packaged app on macOS and Windows', () => {
    expect(shouldRegisterLoginItem('darwin', true)).toBe(true)
    expect(shouldRegisterLoginItem('win32', true)).toBe(true)
    // Linux has no login-item API; dev builds would point at the throwaway binary.
    expect(shouldRegisterLoginItem('linux', true)).toBe(false)
    expect(shouldRegisterLoginItem('darwin', false)).toBe(false)
    expect(shouldRegisterLoginItem('win32', false)).toBe(false)
  })
})

describe('applyLaunchAtLogin', () => {
  it('enables open-at-login when the guard passes', () => {
    const setLoginItemSettings = vi.fn()
    applyLaunchAtLogin({ platform: 'darwin', isPackaged: true, setLoginItemSettings })
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, openAsHidden: true })
  })

  it('does nothing when the guard fails', () => {
    const setLoginItemSettings = vi.fn()
    applyLaunchAtLogin({ platform: 'linux', isPackaged: true, setLoginItemSettings })
    applyLaunchAtLogin({ platform: 'darwin', isPackaged: false, setLoginItemSettings })
    expect(setLoginItemSettings).not.toHaveBeenCalled()
  })
})

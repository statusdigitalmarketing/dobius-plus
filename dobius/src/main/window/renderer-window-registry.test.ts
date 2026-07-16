import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { registerRendererWindow, rendererWindowContents } from './renderer-window-registry'
import type { BrowserWindow, WebContents } from 'electron'

type FakeBrowserWindow = EventEmitter & {
  destroyed: boolean
  contentsDestroyed: boolean
  isDestroyed: () => boolean
  webContents: WebContents
}

function makeWindow(id: number): FakeBrowserWindow {
  const emitter = new EventEmitter() as FakeBrowserWindow
  emitter.destroyed = false
  emitter.contentsDestroyed = false
  emitter.isDestroyed = () => emitter.destroyed
  emitter.webContents = {
    id,
    isDestroyed: () => emitter.contentsDestroyed
  } as WebContents
  return emitter
}

describe('renderer-window-registry', () => {
  const windows: FakeBrowserWindow[] = []
  afterEach(() => {
    for (const win of windows) {
      win.emit('closed')
    }
    windows.length = 0
  })

  function trackedWindow(id: number): FakeBrowserWindow {
    const win = makeWindow(id)
    windows.push(win)
    return win
  }

  it('dedupes registered windows', () => {
    const win = trackedWindow(1)
    registerRendererWindow(win as unknown as BrowserWindow)
    registerRendererWindow(win as unknown as BrowserWindow)
    expect(rendererWindowContents()).toEqual([win.webContents])
  })

  it('auto-removes windows on closed', () => {
    const win = trackedWindow(2)
    registerRendererWindow(win as unknown as BrowserWindow)
    win.emit('closed')
    expect(rendererWindowContents()).not.toContain(win.webContents)
  })

  it('skips destroyed windows and webContents', () => {
    const win = trackedWindow(3)
    const destroyedWin = trackedWindow(4)
    const destroyedContents = trackedWindow(5)
    destroyedWin.destroyed = true
    destroyedContents.contentsDestroyed = true
    registerRendererWindow(win as unknown as BrowserWindow)
    registerRendererWindow(destroyedWin as unknown as BrowserWindow)
    registerRendererWindow(destroyedContents as unknown as BrowserWindow)
    expect(rendererWindowContents()).toEqual([win.webContents])
  })
})

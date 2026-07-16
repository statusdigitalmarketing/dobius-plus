import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { createAppRendererWebPreferences } from './createMainWindow'
import { registerRendererWindow } from './renderer-window-registry'
import { attachWebviewHardening } from './webview-hardening'
import type {
  FloatingPhoneBounds,
  FloatingPhoneMode,
  FloatingPhoneUpdate,
  FloatingPhoneWindowArgs,
  FloatingPhoneWindowResult
} from '../../shared/floating-phone'

const DEFAULT_PHONE_WIDTH = 390
const DEFAULT_PHONE_HEIGHT = 820
const MIN_PHONE_WIDTH = 300
const MIN_PHONE_HEIGHT = 560

let floatingPhoneWindow: BrowserWindow | null = null
let lastPhoneArgs: FloatingPhoneUpdate | null = null
let persistedPhoneBounds: FloatingPhoneBounds | null = null

function isFloatingPhoneMode(value: unknown): value is FloatingPhoneMode {
  return value === 'web' || value === 'app'
}

function normalizePhoneUrl(value: unknown): string | null | undefined {
  if (value == null || value === '') {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function isFiniteBounds(value: FloatingPhoneBounds): boolean {
  return [value.x, value.y, value.width, value.height].every(Number.isFinite)
}

function clampPhoneBounds(bounds?: FloatingPhoneBounds | null): FloatingPhoneBounds {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const width = Math.min(bounds?.width ?? DEFAULT_PHONE_WIDTH, display.workArea.width)
  const height = Math.min(bounds?.height ?? DEFAULT_PHONE_HEIGHT, display.workArea.height)
  const targetX = bounds?.x ?? cursor.x - 32
  const targetY = bounds?.y ?? cursor.y - 32
  return {
    x: Math.max(
      display.workArea.x,
      Math.min(targetX, display.workArea.x + display.workArea.width - width)
    ),
    y: Math.max(
      display.workArea.y,
      Math.min(targetY, display.workArea.y + display.workArea.height - height)
    ),
    width,
    height
  }
}

function sanitizePhoneArgs(args: FloatingPhoneWindowArgs): FloatingPhoneUpdate | null {
  const mode = isFloatingPhoneMode(args.mode) ? args.mode : 'app'
  const url = normalizePhoneUrl(args.url)
  if (url === undefined) {
    return null
  }
  return {
    mode,
    worktreeId: typeof args.worktreeId === 'string' ? args.worktreeId : null,
    url
  }
}

function buildPhoneHash(args: FloatingPhoneUpdate): string {
  const params = new URLSearchParams({ 'phone-visual': '1', mode: args.mode })
  if (args.worktreeId) {
    params.set('worktree', args.worktreeId)
  }
  if (args.url) {
    params.set('url', args.url)
  }
  return params.toString()
}

function focusAndNudgePhoneWindow(win: BrowserWindow): void {
  const nudge = (): void => {
    if (win.isDestroyed()) {
      return
    }
    win.focus()
    win.webContents.focus()
    const [width, height] = win.getSize()
    win.setSize(width, height + 1)
    win.setSize(width, height)
  }
  setTimeout(nudge, 300)
  setTimeout(nudge, 800)
}

export function openFloatingPhoneWindow(args: FloatingPhoneWindowArgs): FloatingPhoneWindowResult {
  const normalizedArgs = sanitizePhoneArgs(args)
  if (!normalizedArgs) {
    return { ok: false }
  }

  if (floatingPhoneWindow && !floatingPhoneWindow.isDestroyed()) {
    floatingPhoneWindow.focus()
    if (JSON.stringify(lastPhoneArgs) !== JSON.stringify(normalizedArgs)) {
      lastPhoneArgs = normalizedArgs
      floatingPhoneWindow.webContents.send('phone-visual:update', normalizedArgs)
    }
    return { ok: true, windowId: floatingPhoneWindow.id }
  }

  const bounds = clampPhoneBounds(
    persistedPhoneBounds && isFiniteBounds(persistedPhoneBounds) ? persistedPhoneBounds : null
  )
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_PHONE_WIDTH,
    minHeight: MIN_PHONE_HEIGHT,
    title: 'Phone',
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    show: true,
    autoHideMenuBar: true,
    webPreferences: createAppRendererWebPreferences()
  })
  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(true, 'floating')
  }
  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    persistedPhoneBounds = { x, y, width, height }
  })
  win.on('resized', () => {
    const [x, y] = win.getPosition()
    const [width, height] = win.getSize()
    persistedPhoneBounds = { x, y, width, height }
  })
  win.once('closed', () => {
    if (floatingPhoneWindow === win) {
      floatingPhoneWindow = null
      lastPhoneArgs = null
    }
  })

  floatingPhoneWindow = win
  lastPhoneArgs = normalizedArgs
  registerRendererWindow(win)
  attachWebviewHardening(win.webContents)

  const hash = buildPhoneHash(normalizedArgs)
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  win.webContents.once('did-finish-load', () => focusAndNudgePhoneWindow(win))

  return { ok: true, windowId: win.id }
}

export function registerFloatingPhoneWindowHandlers(): void {
  ipcMain.removeHandler('window:openPhoneVisual')
  ipcMain.handle(
    'window:openPhoneVisual',
    (_event, args: FloatingPhoneWindowArgs): FloatingPhoneWindowResult => {
      return openFloatingPhoneWindow(args)
    }
  )

  ipcMain.removeHandler('phone-visual:close')
  ipcMain.handle('phone-visual:close', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.removeHandler('phone-visual:minimize')
  ipcMain.handle('phone-visual:minimize', (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.removeHandler('phone-visual:toggleMaximize')
  ipcMain.handle('phone-visual:toggleMaximize', (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) {
      return
    }
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.removeHandler('phone-visual:setBounds')
  ipcMain.handle('phone-visual:setBounds', (event, bounds: FloatingPhoneBounds): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || !isFiniteBounds(bounds)) {
      return
    }
    const clamped = clampPhoneBounds(bounds)
    persistedPhoneBounds = clamped
    win.setBounds(clamped)
  })
}

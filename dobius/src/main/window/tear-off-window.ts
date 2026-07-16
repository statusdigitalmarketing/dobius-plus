import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import { hasLivePty, killPty } from '../ipc/pty'
import { createAppRendererWebPreferences } from './createMainWindow'
import { registerRendererWindow } from './renderer-window-registry'

type TearOffTerminalBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type TearOffTerminalRequest = {
  tabId: string
  ptyId: string
  title?: string
  worktreeId?: string
  worktreeName?: string
  bounds?: TearOffTerminalBounds
}

export type TearOffTerminalResult = { ok: true; windowId: number } | { ok: false }

function isFiniteBounds(value: TearOffTerminalBounds): boolean {
  return [value.x, value.y, value.width, value.height].every(Number.isFinite)
}

function resolveTearOffBounds(bounds: TearOffTerminalBounds | undefined): TearOffTerminalBounds {
  if (bounds && isFiniteBounds(bounds) && bounds.width >= 320 && bounds.height >= 240) {
    return bounds
  }
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const width = Math.min(900, display.workArea.width)
  const height = Math.min(600, display.workArea.height)
  return {
    x: Math.max(
      display.workArea.x,
      Math.min(cursor.x - 32, display.workArea.x + display.workArea.width - width)
    ),
    y: Math.max(
      display.workArea.y,
      Math.min(cursor.y - 32, display.workArea.y + display.workArea.height - height)
    ),
    width,
    height
  }
}

export function validateTearOffTerminalRequest(args: TearOffTerminalRequest): boolean {
  // Why: all app windows use the same first-party preload; liveness is the
  // authorization boundary for granting a renderer another view of a PTY.
  return isValidTerminalTabId(args.tabId) && hasLivePty(args.ptyId)
}

export function openTornOffTerminalWindow(args: TearOffTerminalRequest): TearOffTerminalResult {
  if (!validateTearOffTerminalRequest(args)) {
    return { ok: false }
  }

  const bounds = resolveTearOffBounds(args.bounds)
  const title = args.title?.trim() || 'Terminal'
  const worktreeName = args.worktreeName?.trim() || ''
  // Label the floating window with its origin project so it is identifiable
  // among several torn-off terminals. This pinned title wins over any
  // page-driven change (see the page-title-updated guard below).
  const windowTitle = worktreeName ? `${worktreeName} — ${title}` : title
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 240,
    title: windowTitle,
    show: true,
    autoHideMenuBar: true,
    webPreferences: createAppRendererWebPreferences()
  })
  // Why: the renderer's index.html <title> would otherwise flash in the window
  // titlebar before React sets the terminal title. Pin our title at creation
  // and reject page-driven title changes so only "Terminal N" ever shows.
  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  registerRendererWindow(win)

  const params = new URLSearchParams({
    'terminal-tab': args.tabId,
    pty: args.ptyId,
    title
  })
  if (args.worktreeId?.trim()) {
    params.set('worktree', args.worktreeId.trim())
  }
  if (worktreeName) {
    params.set('worktree-name', worktreeName)
  }
  const hash = params.toString()
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }

  // Why: reusing the main app's TerminalPane in a bare window races the pane
  // manager's fit — the xterm can render blank because the container is
  // measured before layout settles, and nothing resizes afterward (unlike the
  // main window). A real 1px size nudge after load forces the pane's
  // ResizeObserver to fit once the manager is ready and the container has its
  // final size; focusing makes the terminal typeable without a user click.
  win.webContents.once('did-finish-load', () => {
    const nudge = (): void => {
      if (win.isDestroyed()) {
        return
      }
      win.focus()
      win.webContents.focus()
      const [w, h] = win.getSize()
      win.setSize(w, h + 1)
      win.setSize(w, h)
    }
    setTimeout(nudge, 300)
    setTimeout(nudge, 800)
  })

  win.once('closed', () => {
    if (hasLivePty(args.ptyId)) {
      void killPty(args.ptyId)
    }
  })

  return { ok: true, windowId: win.id }
}

export function registerTearOffWindowHandlers(): void {
  ipcMain.removeHandler('window:tearOffTerminal')
  ipcMain.handle(
    'window:tearOffTerminal',
    (_event, args: TearOffTerminalRequest): TearOffTerminalResult => {
      return openTornOffTerminalWindow(args)
    }
  )
}

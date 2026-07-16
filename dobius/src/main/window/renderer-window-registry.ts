import type { BrowserWindow, WebContents } from 'electron'

const rendererWindows = new Set<BrowserWindow>()

export function registerRendererWindow(win: BrowserWindow): void {
  rendererWindows.add(win)
  win.once('closed', () => {
    rendererWindows.delete(win)
  })
}

export function rendererWindowContents(): WebContents[] {
  const contents: WebContents[] = []
  for (const win of rendererWindows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      continue
    }
    contents.push(win.webContents)
  }
  return contents
}

// Why: PTY input is only accepted from first-party app windows (main + torn-off
// terminals). Webview guests / offscreen windows are never registered, so this
// keeps the write guard rejecting keystroke injection from untrusted frames.
export function isRegisteredRendererWebContents(contents: WebContents): boolean {
  return rendererWindowContents().includes(contents)
}

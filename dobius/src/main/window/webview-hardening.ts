import type { WebContents } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { DOBIUS_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'

export function attachWebviewHardening(webContents: WebContents): void {
  webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''

    // Why: arbitrary sites must stay inside an unprivileged guest surface. We
    // fail closed here so a renderer bug cannot smuggle preload, Node, or a
    // non-browser partition into the guest and widen the app privilege boundary.
    // The one allowed data URL is Dobius's inert blank-tab bootstrap page; deny
    // every other data URL so the renderer cannot inject arbitrary inline HTML.
    // Why: session profiles use per-profile partitions (e.g.
    // persist:dobius-browser-session-<uuid>). The registry is the sole authority
    // for which partitions are valid — renderer-provided strings that are not
    // in the allowlist are rejected.
    if (!normalizedSrc || !browserSessionRegistry.isAllowedPartition(partition)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    // Why: older Electron builds expose preloadURL alongside preload; delete
    // both so the guest surface cannot inherit the main preload bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.enableBlinkFeatures = ''
    webPreferences.disableBlinkFeatures = ''
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    // Why: keep renderer-created webviews aligned with the browser guest policy
    // even if the host markup omits or misspells a preference.
    Object.assign(webPreferences, DOBIUS_BROWSER_GUEST_WEB_PREFERENCES)
    // Why: preserve the registry-validated partition instead of forcing the
    // legacy constant. This lets imported/isolated session profiles use their
    // own cookie/storage partition while keeping all other hardening intact.
    webPreferences.partition = partition
  })

  webContents.on('did-attach-webview', (_event, guest) => {
    // Why: popup and navigation policy must attach as soon as Chromium creates
    // the guest webContents. Waiting until renderer-driven registration leaves
    // a race where target=_blank or early redirects can bypass Dobius's intended
    // fallback behavior.
    browserManager.attachGuestPolicies(guest)
  })
}

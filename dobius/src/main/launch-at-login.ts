import { app } from 'electron'

/**
 * Why: on a full OS restart macOS/Windows kill both Dobius+ and its detached
 * session daemon. The daemon is spawned BY the app, so nothing brings it back
 * until the user manually reopens Dobius+ — that is the "daemon isn't staying up
 * after a restart" symptom. Registering the app as a login item makes the OS
 * relaunch it after reboot; app startup then re-ensures the daemon and
 * cold-restores sessions (endedAt stays null on signal shutdown), so terminals
 * come back with their most recent context automatically.
 *
 * The OS's own Login Items list is the off switch — no in-app toggle needed.
 */

/**
 * setLoginItemSettings is a no-op on Linux and pointless in dev (it would point
 * the login item at the throwaway Electron dev binary). Only register for the
 * packaged app on the two platforms Electron actually supports.
 */
export function shouldRegisterLoginItem(platform: NodeJS.Platform, isPackaged: boolean): boolean {
  if (!isPackaged) {return false}
  return platform === 'darwin' || platform === 'win32'
}

export function applyLaunchAtLogin(
  deps: {
    platform: NodeJS.Platform
    isPackaged: boolean
    setLoginItemSettings: typeof app.setLoginItemSettings
  } = {
    platform: process.platform,
    isPackaged: app.isPackaged,
    setLoginItemSettings: app.setLoginItemSettings.bind(app)
  }
): void {
  if (!shouldRegisterLoginItem(deps.platform, deps.isPackaged)) {return}
  // openAsHidden is macOS-only; a hidden relaunch still boots the daemon while
  // keeping windows out of the way until the user opens Dobius+.
  deps.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
}

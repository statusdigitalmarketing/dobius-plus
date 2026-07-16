import { ipcMain, shell } from 'electron'
import type { ImessageBridgeConfig } from '../../shared/imessage-bridge'
import {
  getImessageBridgeConfig,
  getImessageBridgeStatus,
  restartImessageBridge,
  testImessageSend,
  updateImessageBridgeConfig
} from '../imessage-bridge/bridge-service'

// Deep link to the Full Disk Access pane; reading chat.db requires the grant.
const MACOS_FULL_DISK_ACCESS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

export function registerImessageBridgeHandlers(): void {
  ipcMain.removeHandler('imessageBridge:getConfig')
  ipcMain.handle('imessageBridge:getConfig', () => getImessageBridgeConfig())

  ipcMain.removeHandler('imessageBridge:updateConfig')
  ipcMain.handle(
    'imessageBridge:updateConfig',
    (_event, updates: Partial<Omit<ImessageBridgeConfig, 'lastSeenRowid'>>) => {
      // Why: lastSeenRowid is bridge-owned dispatch state; a renderer must not
      // be able to rewind it and replay old messages as commands.
      const { enabled, triggerPrefix, selfHandle } = updates
      const next = updateImessageBridgeConfig({ enabled, triggerPrefix, selfHandle })
      restartImessageBridge()
      return next
    }
  )

  ipcMain.removeHandler('imessageBridge:status')
  ipcMain.handle('imessageBridge:status', () => getImessageBridgeStatus())

  ipcMain.removeHandler('imessageBridge:openFullDiskAccess')
  ipcMain.handle('imessageBridge:openFullDiskAccess', () =>
    shell.openExternal(MACOS_FULL_DISK_ACCESS_URL)
  )

  ipcMain.removeHandler('imessageBridge:testSend')
  ipcMain.handle('imessageBridge:testSend', () => testImessageSend())
}

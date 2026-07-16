import { useCallback, useEffect, useState } from 'react'
import type { ImessageBridgeConfig, ImessageBridgeStatus } from '../../../../shared/imessage-bridge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'
import { getImessageBridgeSearchEntry } from './imessage-bridge-search'
import { translate } from '@/i18n/i18n'

/** macOS-only Settings block for the iMessage bridge: text yourself with a
 *  trigger prefix and the command is typed into the active terminal. The
 *  parent gates rendering to macOS (chat.db + Messages.app are required). */
export function ImessageBridgeSetting(): React.JSX.Element {
  const [config, setConfig] = useState<ImessageBridgeConfig | null>(null)
  const [status, setStatus] = useState<ImessageBridgeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [testFeedback, setTestFeedback] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [nextConfig, nextStatus] = await Promise.all([
      window.api.imessageBridge.getConfig(),
      window.api.imessageBridge.status()
    ])
    setConfig(nextConfig)
    setStatus(nextStatus)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(
    async (updates: Partial<Omit<ImessageBridgeConfig, 'lastSeenRowid'>>) => {
      setBusy(true)
      try {
        await window.api.imessageBridge.updateConfig(updates)
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const runTestSend = useCallback(async () => {
    setBusy(true)
    setTestFeedback(null)
    try {
      const result = await window.api.imessageBridge.testSend()
      setTestFeedback(
        result.ok
          ? translate(
              'auto.components.settings.ImessageBridgeSetting.testSent',
              'Sent. Check your Messages app.'
            )
          : translate(
              'auto.components.settings.ImessageBridgeSetting.testFailed',
              'Failed: {{error}}',
              { error: result.error }
            )
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const chatDbGranted = status?.chatDbReadable.ok === true

  return (
    <SearchableSetting
      title={getImessageBridgeSearchEntry().title}
      description={getImessageBridgeSearchEntry().description}
      keywords={getImessageBridgeSearchEntry().keywords}
      className="space-y-1 py-2"
      id="imessage-bridge"
    >
      <SettingsRow
        label={translate(
          'auto.components.settings.ImessageBridgeSetting.enableLabel',
          'iMessage Bridge'
        )}
        description={translate(
          'auto.components.settings.ImessageBridgeSetting.enableDescription',
          'Text yourself in Messages with the trigger prefix below to type the command into the active terminal.'
        )}
        control={
          <SettingsSwitch
            checked={config?.enabled === true}
            disabled={busy || !config}
            ariaLabel={translate(
              'auto.components.settings.ImessageBridgeSetting.enableAriaLabel',
              'Toggle iMessage bridge'
            )}
            onChange={() => {
              if (config) {
                void save({ enabled: !config.enabled })
              }
            }}
          />
        }
      />

      <SettingsRow
        label={translate(
          'auto.components.settings.ImessageBridgeSetting.prefixLabel',
          'Trigger prefix'
        )}
        description={translate(
          'auto.components.settings.ImessageBridgeSetting.prefixDescription',
          "Commands must start with this. Default 'd:' (e.g. 'd: git status')."
        )}
        control={
          <Input
            value={config?.triggerPrefix ?? ''}
            maxLength={10}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={!config}
            className="h-7 w-20 font-mono text-xs"
            onChange={(event) =>
              setConfig((prev) => (prev ? { ...prev, triggerPrefix: event.target.value } : prev))
            }
            onBlur={() => {
              if (config) {
                void save({ triggerPrefix: config.triggerPrefix })
              }
            }}
          />
        }
      />

      <SettingsRow
        label={translate(
          'auto.components.settings.ImessageBridgeSetting.handleLabel',
          'Your iMessage handle'
        )}
        description={translate(
          'auto.components.settings.ImessageBridgeSetting.handleDescription',
          'Email or phone number Messages.app is signed into. The bridge only reads messages you send to yourself from this handle.'
        )}
        control={
          <Input
            value={config?.selfHandle ?? ''}
            placeholder={translate(
              'auto.components.settings.ImessageBridgeSetting.handlePlaceholder',
              'you@icloud.com or +1234567890'
            )}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={!config}
            className="h-7 w-56 font-mono text-xs"
            onChange={(event) =>
              setConfig((prev) =>
                prev ? { ...prev, selfHandle: event.target.value || null } : prev
              )
            }
            onBlur={() => {
              if (config) {
                void save({ selfHandle: config.selfHandle })
              }
            }}
          />
        }
      />

      <SettingsRow
        label={translate(
          'auto.components.settings.ImessageBridgeSetting.fdaLabel',
          'Full Disk Access'
        )}
        description={
          chatDbGranted
            ? translate(
                'auto.components.settings.ImessageBridgeSetting.fdaGranted',
                'Granted. {{messageCount}} messages readable.',
                {
                  messageCount: status?.chatDbReadable.ok ? status.chatDbReadable.messageCount : 0
                }
              )
            : translate(
                'auto.components.settings.ImessageBridgeSetting.fdaRequired',
                'Required. Dobius+ needs Full Disk Access to read ~/Library/Messages/chat.db.'
              )
        }
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void window.api.imessageBridge.openFullDiskAccess()}
          >
            {translate(
              'auto.components.settings.ImessageBridgeSetting.fdaButton',
              'Open System Settings'
            )}
          </Button>
        }
      />

      <SettingsRow
        label={translate('auto.components.settings.ImessageBridgeSetting.testLabel', 'Test send')}
        description={
          testFeedback ??
          translate(
            'auto.components.settings.ImessageBridgeSetting.testDescription',
            'Sends a test iMessage to your handle to confirm the send pipeline works.'
          )
        }
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy || !config?.selfHandle}
            onClick={() => void runTestSend()}
          >
            {translate('auto.components.settings.ImessageBridgeSetting.testButton', 'Test')}
          </Button>
        }
      />

      {status ? (
        <p className="pt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ImessageBridgeSetting.statusLine',
            'Status: {{state}} · last message row: {{rowid}} · sent in last minute: {{outbound}}',
            {
              state: status.isRunning
                ? translate(
                    'auto.components.settings.ImessageBridgeSetting.statusRunning',
                    'running'
                  )
                : translate(
                    'auto.components.settings.ImessageBridgeSetting.statusStopped',
                    'stopped'
                  ),
              rowid: status.lastSeenRowid,
              outbound: status.outboundLastMin
            }
          )}
        </p>
      ) : null}
    </SearchableSetting>
  )
}

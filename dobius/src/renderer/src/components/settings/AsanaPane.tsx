import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AsanaConfig } from '../../../../shared/asana'
import type { CustomAgent } from '../../../../shared/agents'
import type { TuiAgent } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'
import { getAsanaPaneSearchEntries } from './asana-search'
import { useAppStore } from '../../store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  filterEnabledTuiAgents,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../../shared/tui-agent-selection'
import { translate } from '@/i18n/i18n'

const NO_TRIAGE_AGENT_VALUE = '__none__'

export function AsanaPane(): React.JSX.Element {
  const tokenInputRef = useRef<HTMLInputElement | null>(null)
  const [config, setConfig] = useState<AsanaConfig | null>(null)
  const [agents, setAgents] = useState<CustomAgent[]>([])
  const [hasToken, setHasToken] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const disabledTuiAgents = useAppStore((state) => state.settings?.disabledTuiAgents ?? [])
  const agentCatalog = getAgentCatalog()
  const enabledBuildAgents = filterEnabledTuiAgents(TUI_AGENT_AUTO_PICK_ORDER, disabledTuiAgents)
  const enabledBuildAgentSet = new Set(enabledBuildAgents)
  const configuredBuildAgent = config?.autoMode.buildAgent ?? 'claude'
  const buildAgentValue = enabledBuildAgentSet.has(configuredBuildAgent)
    ? configuredBuildAgent
    : (enabledBuildAgents[0] ?? 'claude')

  const refresh = useCallback(async () => {
    const [nextConfig, nextHasToken, nextAgents] = await Promise.all([
      window.api.asana.getConfig(),
      window.api.asana.hasToken(),
      window.api.agents.list()
    ])
    setConfig(nextConfig)
    setHasToken(nextHasToken)
    setAgents(nextAgents)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveConfig = useCallback(async (updates: Partial<AsanaConfig>) => {
    setBusy(true)
    try {
      const next = await window.api.asana.updateConfig(updates)
      setConfig(next)
    } finally {
      setBusy(false)
    }
  }, [])

  const setToken = useCallback(async () => {
    const input = tokenInputRef.current
    const token = input?.value.trim() ?? ''
    if (!token) {
      setFeedback(
        translate(
          'auto.components.settings.AsanaPane.tokenRequired',
          'Enter a Personal Access Token before setting it.'
        )
      )
      return
    }
    setBusy(true)
    setFeedback(null)
    try {
      await window.api.asana.setToken(token)
      if (input) {
        input.value = ''
      }
      setHasToken(true)
      const msg = translate('auto.components.settings.AsanaPane.tokenSet', 'Asana token saved.')
      setFeedback(msg)
      toast.success(msg)
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : translate('auto.components.settings.AsanaPane.tokenFailed', 'Could not save token.')
      setFeedback(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }, [])

  const clearToken = useCallback(async () => {
    setBusy(true)
    setFeedback(null)
    try {
      await window.api.asana.clearToken()
      if (tokenInputRef.current) {
        tokenInputRef.current.value = ''
      }
      setHasToken(false)
      const msg = translate('auto.components.settings.AsanaPane.tokenCleared', 'Token cleared.')
      setFeedback(msg)
      toast.success(msg)
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.AsanaPane.tokenClearFailed',
              'Could not clear token.'
            )
      setFeedback(msg)
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }, [])

  const searchEntry = getAsanaPaneSearchEntries()[0]
  const isEnabledBuildAgent = (value: string): value is TuiAgent =>
    enabledBuildAgentSet.has(value as TuiAgent)

  return (
    <div className="space-y-4">
      <SearchableSetting
        title={searchEntry.title}
        description={searchEntry.description}
        keywords={searchEntry.keywords}
        className="space-y-1 py-2"
        id="asana-automation"
      >
        <SettingsRow
          label={translate(
            'auto.components.settings.AsanaPane.tokenLabel',
            'Asana Personal Access Token'
          )}
          description={
            feedback ??
            (hasToken
              ? translate('auto.components.settings.AsanaPane.tokenStatusSet', '● Connected')
              : translate('auto.components.settings.AsanaPane.tokenStatusNotSet', 'Not connected'))
          }
          alignTop
          control={
            <div className="flex flex-wrap justify-end gap-2">
              <Input
                ref={tokenInputRef}
                type="password"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                placeholder={translate(
                  'auto.components.settings.AsanaPane.tokenPlaceholder',
                  'New token'
                )}
                disabled={busy}
                className="h-7 w-56 font-mono text-xs"
              />
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={() => void setToken()}
              >
                {translate('auto.components.settings.AsanaPane.setTokenButton', 'Set')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy || !hasToken}
                onClick={() => void clearToken()}
              >
                {translate('auto.components.settings.AsanaPane.clearTokenButton', 'Clear')}
              </Button>
            </div>
          }
        />

        <SettingsRow
          label={translate('auto.components.settings.AsanaPane.buildLaneLabel', 'Build lane GID')}
          description={translate(
            'auto.components.settings.AsanaPane.buildLaneDescription',
            'Asana assignee GID for build-lane tasks.'
          )}
          control={
            <Input
              value={config?.myGid ?? ''}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={!config || busy}
              className="h-7 w-56 font-mono text-xs"
              onChange={(event) =>
                setConfig((prev) => (prev ? { ...prev, myGid: event.target.value } : prev))
              }
              onBlur={() => {
                if (config) {
                  void saveConfig({ myGid: config.myGid })
                }
              }}
            />
          }
        />

        <SettingsRow
          label={translate('auto.components.settings.AsanaPane.reviewLaneLabel', 'Review lane GID')}
          description={translate(
            'auto.components.settings.AsanaPane.reviewLaneDescription',
            'Asana assignee GID for review-lane tasks.'
          )}
          control={
            <Input
              value={config?.reviewGid ?? ''}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              disabled={!config || busy}
              className="h-7 w-56 font-mono text-xs"
              onChange={(event) =>
                setConfig((prev) => (prev ? { ...prev, reviewGid: event.target.value } : prev))
              }
              onBlur={() => {
                if (config) {
                  void saveConfig({ reviewGid: config.reviewGid })
                }
              }}
            />
          }
        />

        <SettingsRow
          label={translate('auto.components.settings.AsanaPane.autoModeLabel', 'Auto Mode')}
          description={translate(
            'auto.components.settings.AsanaPane.autoModeDescription',
            'Polls Asana for new build and review lane tasks.'
          )}
          control={
            <SettingsSwitch
              checked={config?.autoMode.enabled === true}
              disabled={!config || busy}
              ariaLabel={translate(
                'auto.components.settings.AsanaPane.autoModeAriaLabel',
                'Toggle Asana Auto Mode'
              )}
              onChange={() => {
                if (config) {
                  void saveConfig({
                    autoMode: { ...config.autoMode, enabled: !config.autoMode.enabled }
                  })
                }
              }}
            />
          }
        />

        <SettingsRow
          label={translate('auto.components.settings.AsanaPane.triageAgentLabel', 'Triage agent')}
          description={translate(
            'auto.components.settings.AsanaPane.triageAgentDescription',
            'Summarizes newly claimed Asana tasks and drafts clarification questions when needed.'
          )}
          control={
            <Select
              value={config?.autoMode.triageAgentId ?? NO_TRIAGE_AGENT_VALUE}
              disabled={!config || busy}
              onValueChange={(value) => {
                if (!config) {
                  return
                }
                const triageAgentId = value === NO_TRIAGE_AGENT_VALUE ? undefined : value
                void saveConfig({ autoMode: { ...config.autoMode, triageAgentId } })
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={NO_TRIAGE_AGENT_VALUE}>
                  {translate('auto.components.settings.AsanaPane.noTriageAgent', 'No agent')}
                </SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingsRow
          label={translate('auto.components.settings.AsanaPane.buildAgentLabel', 'Build agent')}
          description={translate(
            'auto.components.settings.AsanaPane.buildAgentDescription',
            'Terminal agent used when dispatch_build creates a build worktree.'
          )}
          control={
            <Select
              value={buildAgentValue}
              disabled={!config || busy || enabledBuildAgents.length === 0}
              onValueChange={(value) => {
                if (!config || !isEnabledBuildAgent(value)) {
                  return
                }
                void saveConfig({ autoMode: { ...config.autoMode, buildAgent: value } })
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {enabledBuildAgents.map((agentId) => (
                  <SelectItem key={agentId} value={agentId}>
                    {agentCatalog.find((agent) => agent.id === agentId)?.label ?? agentId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <SettingsRow
          label={translate('auto.components.settings.AsanaPane.intervalLabel', 'Poll interval')}
          description={translate(
            'auto.components.settings.AsanaPane.intervalDescription',
            'Minutes between Asana refreshes while Auto Mode is enabled.'
          )}
          control={
            <Input
              type="number"
              min={1}
              step={1}
              value={config?.autoMode.intervalMinutes ?? 10}
              disabled={!config || busy}
              className="h-7 w-24 text-xs"
              onChange={(event) => {
                const intervalMinutes = Math.max(1, Math.floor(Number(event.target.value) || 1))
                setConfig((prev) =>
                  prev ? { ...prev, autoMode: { ...prev.autoMode, intervalMinutes } } : prev
                )
              }}
              onBlur={() => {
                if (config) {
                  void saveConfig({ autoMode: config.autoMode })
                }
              }}
            />
          }
        />
      </SearchableSetting>
    </div>
  )
}

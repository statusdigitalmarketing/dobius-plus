import { CheckCircle2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'

type BehaviorPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: these behaviors have no safe alternative, so they stay automatic rather
// than becoming toggles. Project terminals are security-contained to their
// worktree (a home-directory start would be rejected at spawn); terminal focus
// is entangled with multi-pane focus restoration; window controls have no valid
// off-position. Only Clean Claude resume below is a real user preference.
const AUTOMATIC_BEHAVIORS = [
  ['Project terminal folder', 'New project terminals start in that project folder.'],
  ['Terminal focus', 'Opening or selecting a terminal moves keyboard input into that terminal.'],
  ['Window controls', 'macOS window controls are aligned automatically in the upper-left.']
] as const

export function BehaviorPane({ settings, updateSettings }: BehaviorPaneProps): React.JSX.Element {
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Recommended behavior"
          description="The core Dobius behaviors that stay consistent across projects and computers."
        />
        <div className="divide-y divide-border/40">
          <SettingsSwitchRow
            label="Clean Claude resume"
            description="Resume a Claude session in its recorded folder and run only the resume command, with no cd prefix. Turn off to use the older cd-then-resume command."
            checked={settings.cleanClaudeResume ?? true}
            onChange={() =>
              updateSettings({ cleanClaudeResume: !(settings.cleanClaudeResume ?? true) })
            }
          />
        </div>
        <div className="divide-y divide-border/40 rounded-md border border-border/60 px-3">
          {AUTOMATIC_BEHAVIORS.map(([title, description]) => (
            <div key={title} className="flex items-start gap-3 py-3">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Automatic
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Keep the interface focused"
          description="Hide top-level shortcuts you do not use. Every feature remains available from Settings."
        />
        <div className="divide-y divide-border/40">
          <SettingsSwitchRow
            label="Show Tasks shortcut"
            description="Show Tasks in the main sidebar."
            checked={settings.showTasksButton}
            onChange={() => updateSettings({ showTasksButton: !settings.showTasksButton })}
          />
          <SettingsSwitchRow
            label="Show Automations shortcut"
            description="Show Automations in the main sidebar."
            checked={settings.showAutomationsButton ?? true}
            onChange={() =>
              updateSettings({ showAutomationsButton: !(settings.showAutomationsButton ?? true) })
            }
          />
          <SettingsSwitchRow
            label="Show Mobile shortcut"
            description="Show Dobius Mobile in the main sidebar."
            checked={settings.showMobileButton ?? true}
            onChange={() =>
              updateSettings({ showMobileButton: !(settings.showMobileButton ?? true) })
            }
          />
          <SettingsSwitchRow
            label="Open agents in the Dobius text view"
            description="New coding-agent tabs open in the focused chat/text surface instead of raw terminal mode."
            checked={settings.openAgentTabsInChatByDefault ?? false}
            onChange={() =>
              updateSettings({
                openAgentTabsInChatByDefault: !(settings.openAgentTabsInChatByDefault ?? false),
                ...(!(settings.openAgentTabsInChatByDefault ?? false)
                  ? { experimentalNativeChat: true }
                  : {})
              })
            }
          />
        </div>
      </section>

      <section className="space-y-3">
        <SettingsSubsectionHeader
          title="Walkthrough"
          description="Review projects, terminals, agents, resumes, and the main Dobius workflow."
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => openSettingsTarget({ pane: 'setup-guide', repoId: null })}
        >
          Open onboarding checklist
        </Button>
      </section>
    </div>
  )
}

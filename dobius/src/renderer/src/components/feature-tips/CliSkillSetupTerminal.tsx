import { Copy, Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import {
  DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
  DOBIUS_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import { translate } from '@/i18n/i18n'

export function CliSkillSetupTerminal(): React.JSX.Element {
  const [installing, setInstalling] = useState(false)

  const handleCopySkillCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND)
      toast.success(
        translate(
          'auto.components.feature.tips.CliSkillSetupTerminal.b8ad063571',
          'Copied the skill install command.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.feature.tips.CliSkillSetupTerminal.6ff813fc1d',
              'Failed to copy skill command.'
            )
      )
    }
  }

  const handleInstallBundledSkills = async (): Promise<void> => {
    if (installing) {
      return
    }
    setInstalling(true)
    try {
      await window.api.skills.installBundled(DOBIUS_CLI_SKILL_NAME)
      await window.api.skills.installBundled(ORCHESTRATION_SKILL_NAME)
      notifyInstalledAgentSkillsChanged()
      toast.success(
        translate(
          'auto.components.feature.tips.CliSkillSetupTerminal.localInstallComplete',
          'Installed bundled Dobius+ skills.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.feature.tips.CliSkillSetupTerminal.localInstallFailed',
              'Failed to install bundled skills.'
            )
      )
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/35 px-3 py-2">
        <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
          {DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND}
        </code>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={() => void handleCopySkillCommand()}
              aria-label={translate(
                'auto.components.feature.tips.CliSkillSetupTerminal.5eca672aac',
                'Copy skill install command'
              )}
            >
              <Copy className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.feature.tips.CliSkillSetupTerminal.5c3aee22c0',
              'Copy command'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <Button
        type="button"
        size="sm"
        className="mt-2"
        onClick={() => void handleInstallBundledSkills()}
        disabled={installing}
      >
        {installing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Download className="size-3.5" />
        )}
        {installing
          ? translate(
              'auto.components.feature.tips.CliSkillSetupTerminal.installing',
              'Installing...'
            )
          : translate(
              'auto.components.feature.tips.CliSkillSetupTerminal.installBundled',
              'Install bundled skills'
            )}
      </Button>
    </div>
  )
}

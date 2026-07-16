import type { VoiceSettings } from '../../../../shared/speech-types'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { translate } from '@/i18n/i18n'

type VoiceConductorSectionProps = {
  voiceSettings: VoiceSettings
  onUpdateVoiceSettings: (updates: Partial<VoiceSettings>) => void
}

export function VoiceConductorSection({
  voiceSettings,
  onUpdateVoiceSettings
}: VoiceConductorSectionProps): React.JSX.Element {
  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <Label>
            {translate('auto.components.settings.VoiceConductor.title', 'Voice Conductor')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.VoiceConductor.description',
              'Run a background Opus session that routes voice commands and dispatched work to the right terminal.'
            )}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={voiceSettings.conductorEnabled}
          aria-label={translate('auto.components.settings.VoiceConductor.title', 'Voice Conductor')}
          onClick={() => onUpdateVoiceSettings({ conductorEnabled: !voiceSettings.conductorEnabled })}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            voiceSettings.conductorEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              voiceSettings.conductorEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <Separator />
    </>
  )
}

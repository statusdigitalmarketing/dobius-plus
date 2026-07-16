import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { Destination } from '../../../../shared/destinations'
import { Field } from './automation-page-parts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { translate } from '@/i18n/i18n'

const NO_DESTINATION = 'none'

type AutomationNotifyFieldProps = {
  draft: AutomationDraft
  destinations: Destination[]
  disabled: boolean
  pickerTriggerClassName: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationNotifyField({
  draft,
  destinations,
  disabled,
  pickerTriggerClassName,
  onDraftChange
}: AutomationNotifyFieldProps): React.JSX.Element {
  const hasDestination = draft.notifyDestinationId !== ''
  return (
    <div className="grid gap-3 pt-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field
        label={translate(
          'auto.components.automations.AutomationNotifyField.1393aacf27',
          'Send results to'
        )}
      >
        <Select
          value={draft.notifyDestinationId || NO_DESTINATION}
          disabled={disabled}
          onValueChange={(value) =>
            onDraftChange((current) => ({
              ...current,
              notifyDestinationId: value === NO_DESTINATION ? '' : value
            }))
          }
        >
          <SelectTrigger className={`w-full ${pickerTriggerClassName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
            <SelectItem value={NO_DESTINATION}>
              {translate(
                'auto.components.automations.AutomationNotifyField.e3fecf3677',
                'No notification'
              )}
            </SelectItem>
            {destinations.map((destination) => (
              <SelectItem key={destination.id} value={destination.id}>
                {destination.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {hasDestination ? (
        <Field
          label={translate(
            'auto.components.automations.AutomationNotifyField.dba8c264b4',
            'Notify on'
          )}
        >
          <Select
            value={draft.notifyOn}
            disabled={disabled}
            onValueChange={(value) =>
              onDraftChange((current) => ({
                ...current,
                notifyOn: value === 'failure' ? 'failure' : 'always'
              }))
            }
          >
            <SelectTrigger className={`w-full ${pickerTriggerClassName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
              <SelectItem value="always">
                {translate(
                  'auto.components.automations.AutomationNotifyField.2546a2890f',
                  'Every run'
                )}
              </SelectItem>
              <SelectItem value="failure">
                {translate(
                  'auto.components.automations.AutomationNotifyField.52f972d83e',
                  'Failures only'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {hasDestination ? (
        <Field
          label={translate(
            'auto.components.automations.AutomationNotifyField.1049016803',
            'Detail'
          )}
        >
          <Select
            value={draft.notifyDepth}
            disabled={disabled}
            onValueChange={(value) =>
              onDraftChange((current) => ({
                ...current,
                notifyDepth: value === 'ping' || value === 'full' ? value : 'brief'
              }))
            }
          >
            <SelectTrigger className={`w-full ${pickerTriggerClassName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
              <SelectItem value="ping">
                {translate(
                  'auto.components.automations.AutomationNotifyField.7603ad8a69',
                  'Ping — status line only'
                )}
              </SelectItem>
              <SelectItem value="brief">
                {translate(
                  'auto.components.automations.AutomationNotifyField.a1ab2211e0',
                  'Brief — short summary'
                )}
              </SelectItem>
              <SelectItem value="full">
                {translate(
                  'auto.components.automations.AutomationNotifyField.8e8352a572',
                  'Full — complete result'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
    </div>
  )
}

import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import type { AgentDraft } from './agent-page-state'

function ScheduleRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-2 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-center">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

export function AgentScheduleEditor({
  draft,
  onDraftChange
}: {
  draft: AgentDraft
  onDraftChange: (draft: AgentDraft) => void
}): React.JSX.Element {
  const heartbeat = draft.heartbeat
  const updateHeartbeat = (updates: Partial<typeof heartbeat>): void => {
    onDraftChange({ ...draft, heartbeat: { ...heartbeat, ...updates } })
  }

  return (
    <div className="rounded-md border border-border bg-card px-3 py-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Schedule</h3>
          <p className="text-xs text-muted-foreground">Heartbeat runs use locked tools.</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={heartbeat.enabled}
            onCheckedChange={(checked) => updateHeartbeat({ enabled: checked === true })}
          />
          Heartbeat
        </label>
      </div>
      <div className="space-y-3">
        <ScheduleRow label="Frequency">
          <Select
            value={heartbeat.frequency}
            onValueChange={(frequency) =>
              updateHeartbeat({ frequency: frequency as typeof heartbeat.frequency })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="every10min">Every 10 min</SelectItem>
              <SelectItem value="hourly">Hourly</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekdays">Weekdays</SelectItem>
            </SelectContent>
          </Select>
        </ScheduleRow>
        <ScheduleRow label="At time">
          <Input
            type="time"
            value={heartbeat.at}
            onChange={(event) => updateHeartbeat({ at: event.target.value })}
          />
        </ScheduleRow>
        <ScheduleRow label="Quiet hours">
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="time"
              value={heartbeat.quietStart}
              onChange={(event) => updateHeartbeat({ quietStart: event.target.value })}
            />
            <Input
              type="time"
              value={heartbeat.quietEnd}
              onChange={(event) => updateHeartbeat({ quietEnd: event.target.value })}
            />
          </div>
        </ScheduleRow>
        <ScheduleRow label="Budget">
          <div className="flex items-center gap-3">
            <Slider
              min={0.1}
              max={2}
              step={0.05}
              value={[heartbeat.maxBudgetUsd]}
              onValueChange={([value]) => updateHeartbeat({ maxBudgetUsd: value ?? 0.5 })}
            />
            <span className="w-14 text-right font-mono text-xs text-muted-foreground">
              ${heartbeat.maxBudgetUsd.toFixed(2)}
            </span>
          </div>
        </ScheduleRow>
        <ScheduleRow label="Max turns">
          <Input
            type="number"
            min={1}
            max={100}
            value={heartbeat.maxTurns}
            onChange={(event) => updateHeartbeat({ maxTurns: Number(event.target.value) })}
          />
        </ScheduleRow>
        <ScheduleRow label="Notify">
          <Select
            value={draft.notify}
            onValueChange={(notify) =>
              onDraftChange({ ...draft, notify: notify as typeof draft.notify })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="urgent only">Urgent only</SelectItem>
              <SelectItem value="digest + urgent">Digest + urgent</SelectItem>
              <SelectItem value="everything">Everything</SelectItem>
            </SelectContent>
          </Select>
        </ScheduleRow>
      </div>
    </div>
  )
}

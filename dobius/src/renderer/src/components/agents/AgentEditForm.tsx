import { Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AGENT_COLORS,
  AGENT_ICONS,
  type AgentIdentityFileName,
  type AgentReadableFiles
} from '../../../../shared/agents'
import { cn } from '@/lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { AGENT_ICON_COMPONENTS } from './AgentAvatar'
import { AgentScheduleEditor } from './AgentScheduleEditor'
import { AgentSkillsPicker } from './AgentSkillsPicker'
import { AgentWorkingDirectoryPicker } from './AgentWorkingDirectoryPicker'
import { AGENT_MODELS, AGENT_TOOLS, type AgentDraft } from './agent-page-state'

const IDENTITY_FILE_NAMES: AgentIdentityFileName[] = ['soul', 'role', 'playbook', 'rules']
const IDENTITY_HINTS: Record<AgentIdentityFileName, string> = {
  soul: 'How does this agent think and talk? Values, tone, when to speak vs stay silent.',
  role: 'The job. What do they own, what do they watch, what does "done" look like?',
  playbook: 'How they work: numbered steps, output format, conventions.',
  rules: 'Hard boundaries, one per line. Phase 1 injects these as instructions.'
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-2 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-start">
      <Label className="pt-2 text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

export function AgentEditForm({
  open,
  draft,
  files,
  activeFile,
  saving,
  onActiveFileChange,
  onDraftChange,
  onFilesChange,
  onDelete,
  onOpenChange,
  onSave
}: {
  open: boolean
  draft: AgentDraft
  files: AgentReadableFiles
  activeFile: AgentIdentityFileName
  saving: boolean
  onActiveFileChange: (name: AgentIdentityFileName) => void
  onDraftChange: (draft: AgentDraft) => void
  onFilesChange: (files: AgentReadableFiles) => void
  onDelete: () => void
  onOpenChange: (open: boolean) => void
  onSave: () => void
}): React.JSX.Element {
  const toggleTool = (tool: string, checked: boolean): void => {
    const allowedTools = new Set(draft.allowedTools ?? [])
    if (checked) {
      allowedTools.add(tool)
    } else {
      allowedTools.delete(tool)
    }
    onDraftChange({ ...draft, allowedTools: [...allowedTools] })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="pr-6">
          <div className="flex items-start gap-3">
            <AgentAvatar
              icon={draft.icon ?? 'bot'}
              color={draft.color ?? AGENT_COLORS[0]}
              className="size-11"
            />
            <div className="min-w-0">
              <DialogTitle>{draft.id ? `Edit ${draft.name}` : 'New crew member'}</DialogTitle>
              <DialogDescription>
                {draft.id
                  ? 'Changes apply to the next run.'
                  : 'Who are they, what do they watch, when do they speak?'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name">
            <Input
              value={draft.name}
              placeholder="e.g. Deploy Watch"
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
            />
          </Field>

          <Field label="Icon">
            <div className="flex flex-wrap gap-2">
              {AGENT_ICONS.map((icon) => {
                const Icon = AGENT_ICON_COMPONENTS[icon]
                return (
                  <Button
                    key={icon}
                    type="button"
                    variant={draft.icon === icon ? 'secondary' : 'outline'}
                    size="icon"
                    aria-label={icon}
                    onClick={() => onDraftChange({ ...draft, icon })}
                  >
                    <Icon className="size-4" />
                  </Button>
                )
              })}
            </div>
          </Field>

          <Field label="Color">
            <div className="flex flex-wrap gap-2">
              {AGENT_COLORS.map((color) => (
                <Button
                  key={color}
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={color}
                  className={cn(draft.color === color && 'ring-2 ring-ring ring-offset-2')}
                  onClick={() => onDraftChange({ ...draft, color })}
                >
                  <span className="size-3.5 rounded-full" style={{ backgroundColor: color }} />
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Tagline">
            <Input
              value={draft.description}
              placeholder="One line shown on the roster"
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
            />
          </Field>

          <Field label="Identity files">
            <div className="min-w-0 space-y-2">
              <Tabs
                value={activeFile}
                onValueChange={(value) => onActiveFileChange(value as AgentIdentityFileName)}
              >
                <TabsList variant="line" className="flex h-auto flex-wrap justify-start">
                  {IDENTITY_FILE_NAMES.map((name) => (
                    <TabsTrigger key={name} value={name} className="font-mono text-xs">
                      {name}.md
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <p className="text-xs text-muted-foreground">{IDENTITY_HINTS[activeFile]}</p>
              <textarea
                value={files[activeFile]}
                spellCheck={false}
                onChange={(event) => onFilesChange({ ...files, [activeFile]: event.target.value })}
                className="min-h-40 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-6 shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>
          </Field>

          <Field label="Model">
            <Select
              value={draft.model}
              onValueChange={(model) => onDraftChange({ ...draft, model })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_MODELS.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Tools">
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {AGENT_TOOLS.map((tool) => (
                  <label
                    key={tool}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <Checkbox
                      checked={(draft.allowedTools ?? []).includes(tool)}
                      onCheckedChange={(checked) => toggleTool(tool, checked === true)}
                    />
                    {tool}
                  </label>
                ))}
              </div>
              <label className="flex items-start gap-3 rounded-md border border-border px-3 py-3">
                <Checkbox
                  checked={draft.bypassPermissions}
                  onCheckedChange={(checked) =>
                    onDraftChange({ ...draft, bypassPermissions: checked === true })
                  }
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium">Bypass permissions</span>
                  <span className="block text-xs text-muted-foreground">
                    Runs tools without asking. Existing permission behavior is unchanged in Phase 1.
                  </span>
                </span>
              </label>
            </div>
          </Field>

          <Field label="Working dir">
            <AgentWorkingDirectoryPicker
              value={draft.cwd}
              onChange={(cwd) => onDraftChange({ ...draft, cwd })}
            />
          </Field>

          <Field label="Skills">
            <AgentSkillsPicker
              cwd={draft.cwd}
              selected={draft.skills}
              onChange={(skills) => onDraftChange({ ...draft, skills })}
            />
          </Field>

          <Field label="Reachable via">
            <label className="flex items-start gap-3 rounded-md border border-border px-3 py-3">
              <Checkbox
                checked={draft.channels.imessage}
                onCheckedChange={(checked) =>
                  onDraftChange({
                    ...draft,
                    channels: { ...draft.channels, imessage: checked === true }
                  })
                }
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">iMessage</span>
                <span className="block text-xs text-muted-foreground">
                  Allows @mentions from your self-thread to start read-only agent runs.
                </span>
              </span>
            </label>
          </Field>

          <AgentScheduleEditor draft={draft} onDraftChange={onDraftChange} />
        </div>

        <DialogFooter className="items-center sm:justify-between">
          {draft.id ? (
            <Button type="button" variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={onSave}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {draft.id ? 'Save changes' : 'Create agent'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { Check, Edit3, Loader2, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'
import type { ProjectFileInfo } from '../../../../shared/project-files'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { SettingsBadge } from './SettingsFormControls'
import { getProjectInstructionStarter } from './project-instruction-templates'

type ProjectInstructionFileRowProps = {
  repo: Repo
  file: ProjectFileInfo
  canCreate?: boolean
  canDelete?: boolean
  onChanged: () => void
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ProjectInstructionFileRow({
  repo,
  file,
  canCreate = false,
  canDelete = false,
  onChanged
}: ProjectInstructionFileRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState('')
  const [exists, setExists] = useState(file.exists)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setExists(file.exists)
  }, [file.exists])

  const loadContent = async (): Promise<void> => {
    if (loaded || loading) {
      return
    }
    setLoading(true)
    try {
      const result = await window.api.projectFiles.read(repo.id, file.name)
      setContent(result.content)
      setExists(result.exists)
      setLoaded(true)
    } catch (error) {
      toast.error(`Failed to load ${file.name}: ${getErrorMessage(error)}`)
    } finally {
      setLoading(false)
    }
  }

  const toggleExpanded = (): void => {
    const nextExpanded = !expanded
    setExpanded(nextExpanded)
    if (nextExpanded) {
      void loadContent()
    }
  }

  const writeContent = async (nextContent: string): Promise<void> => {
    setSaving(true)
    try {
      await window.api.projectFiles.write(repo.id, file.name, nextContent)
      setContent(nextContent)
      setExists(true)
      setLoaded(true)
      toast.success(`Saved ${file.name}`)
      onChanged()
    } catch (error) {
      toast.error(`Failed to save ${file.name}: ${getErrorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = (): void => {
    const starter = getProjectInstructionStarter(file.name, repo.displayName)
    setExpanded(true)
    void writeContent(starter)
  }

  const handleDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await window.api.projectFiles.delete(repo.id, file.name)
      setContent('')
      setExists(false)
      setLoaded(false)
      setExpanded(false)
      toast.success(`Deleted ${file.name}`)
      onChanged()
    } catch (error) {
      toast.error(`Failed to delete ${file.name}: ${getErrorMessage(error)}`)
    } finally {
      setDeleting(false)
    }
  }

  const actionDisabled = loading || saving || deleting
  const badge = exists ? (
    <SettingsBadge tone="accent">
      <Check className="size-3" />
      Present
    </SettingsBadge>
  ) : (
    <SettingsBadge tone="muted">Absent</SettingsBadge>
  )

  return (
    <div className="rounded-xl border border-border/50 bg-background/70 px-3 py-2 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <code className="truncate font-mono text-xs text-foreground">{file.name}</code>
            {badge}
          </div>
          {exists ? <p className="text-[11px] text-muted-foreground">{file.size} bytes</p> : null}
        </div>
        {canCreate && !exists ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={saving}
            onClick={handleCreate}
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : null}
            Create
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={actionDisabled}
          onClick={toggleExpanded}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <Edit3 className="size-3" />}
          Edit
        </Button>
        {canDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={actionDisabled}
            onClick={() => void handleDelete()}
            aria-label={`Delete ${file.name}`}
          >
            {deleting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3 text-destructive" />
            )}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            className={cn(
              'min-h-44 w-full resize-y rounded-md border border-input bg-editor-surface',
              'px-3 py-2 font-mono text-xs text-foreground outline-none',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50'
            )}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={actionDisabled}
              onClick={() => void writeContent(content)}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Pencil, X } from 'lucide-react'
import type { DobiusPrompt } from '../../../../shared/prompts'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

type Editing = { id?: string; title: string; text: string }

export default function PromptsPanel(): React.JSX.Element {
  const [prompts, setPrompts] = useState<DobiusPrompt[]>([])
  const [editing, setEditing] = useState<Editing | null>(null)

  useEffect(() => {
    let disposed = false
    void window.api.prompts.list().then((list) => {
      if (!disposed) {
        setPrompts(list)
      }
    })
    return () => {
      disposed = true
    }
  }, [])

  const inject = useCallback((prompt: DobiusPrompt) => {
    void window.api.prompts.inject(prompt.text)
  }, [])

  const save = useCallback(async () => {
    if (!editing || !editing.title.trim() || !editing.text.trim()) {
      return
    }
    setPrompts(await window.api.prompts.save(editing))
    setEditing(null)
  }, [editing])

  const remove = useCallback(async (id: string) => {
    setPrompts(await window.api.prompts.delete(id))
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.right-sidebar.PromptsPanel.title', 'Prompts')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing({ title: '', text: '' })}
          className="h-6 gap-1 px-2 text-xs"
        >
          <Plus className="size-3" />
          {translate('auto.components.right-sidebar.PromptsPanel.new', 'New')}
        </Button>
      </div>

      {editing && (
        <div className="border-b border-border p-2">
          <input
            value={editing.title}
            onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            placeholder={translate(
              'auto.components.right-sidebar.PromptsPanel.titlePlaceholder',
              'Title'
            )}
            className="mb-1 w-full rounded border border-border bg-transparent px-2 py-1 text-sm text-foreground"
          />
          <textarea
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            placeholder={translate(
              'auto.components.right-sidebar.PromptsPanel.textPlaceholder',
              'Prompt text'
            )}
            rows={4}
            className="w-full rounded border border-border bg-transparent px-2 py-1 font-mono text-xs text-foreground"
          />
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" onClick={save}>
              {translate('auto.components.right-sidebar.PromptsPanel.save', 'Save')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={() => setEditing(null)}
            >
              <X className="size-3" />
              {translate('auto.components.right-sidebar.PromptsPanel.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {prompts.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.right-sidebar.PromptsPanel.empty',
              'No prompts yet. Add a snippet, then click it to type it into the active terminal.'
            )}
          </p>
        ) : (
          prompts.map((prompt) => (
            <div
              key={prompt.id}
              className="group mb-1 flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
            >
              <button
                type="button"
                onClick={() => inject(prompt)}
                className="min-w-0 flex-1 text-left"
                title={prompt.text}
              >
                <div className="truncate text-[13px] text-foreground">{prompt.title}</div>
                <div className="truncate text-xs text-muted-foreground">{prompt.text}</div>
              </button>
              <button
                type="button"
                aria-label={translate('auto.components.right-sidebar.PromptsPanel.edit', 'Edit')}
                onClick={() =>
                  setEditing({ id: prompt.id, title: prompt.title, text: prompt.text })
                }
                className="opacity-0 group-hover:opacity-100"
              >
                <Pencil className="size-3.5 text-muted-foreground hover:text-foreground" />
              </button>
              <button
                type="button"
                aria-label={translate(
                  'auto.components.right-sidebar.PromptsPanel.delete',
                  'Delete'
                )}
                onClick={() => void remove(prompt.id)}
                className="opacity-0 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

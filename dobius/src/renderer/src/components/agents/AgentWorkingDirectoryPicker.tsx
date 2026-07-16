import { FolderOpen, Pencil, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'

export function AgentWorkingDirectoryPicker({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(value.length === 0)
  const sortedRepos = useMemo(
    () => [...repos].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [repos]
  )

  const browse = async (): Promise<void> => {
    try {
      const picked = await window.api.agents.pickDirectory({ defaultPath: value || undefined })
      if (picked) {
        onChange(picked)
        setEditing(false)
        setOpen(false)
      }
    } catch (error) {
      console.error('Failed to pick agent working directory:', error)
      toast.error('Could not open folder picker')
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" className="min-w-0 flex-1 justify-start">
              <FolderOpen className="size-4" />
              <span className="truncate">{value || 'Choose a project'}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(520px,calc(100vw-2rem))] p-2">
            <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Dobius+ projects
            </div>
            <div className="scrollbar-sleek max-h-64 space-y-1 overflow-y-auto">
              {sortedRepos.map((repo) => (
                <button
                  key={repo.id}
                  type="button"
                  className="w-full rounded-md px-2 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    onChange(repo.path)
                    setEditing(false)
                    setOpen(false)
                  }}
                >
                  <span className="block truncate text-sm font-medium">{repo.displayName}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {repo.path}
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-2 border-t border-border pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => void browse()}
              >
                <Search className="size-4" />
                Browse for a folder...
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Edit path"
          onClick={() => setEditing((current) => !current)}
        >
          <Pencil className="size-4" />
        </Button>
      </div>
      {editing ? (
        <Input
          value={value}
          placeholder="~"
          className="font-mono"
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  )
}

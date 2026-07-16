import { Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AgentCrewFileName, AgentCrewFiles } from '../../../../shared/agents'

const CREW_FILE_NAMES: AgentCrewFileName[] = ['USER', 'TOOLS']
const CREW_HINTS: Record<AgentCrewFileName, string> = {
  USER: 'Shared user context every agent should know.',
  TOOLS: 'House tool conventions shared by the whole crew.'
}

export function CrewFilesDialog({
  open,
  files,
  activeFile,
  saving,
  onActiveFileChange,
  onFilesChange,
  onOpenChange,
  onSave
}: {
  open: boolean
  files: AgentCrewFiles
  activeFile: AgentCrewFileName
  saving: boolean
  onActiveFileChange: (name: AgentCrewFileName) => void
  onFilesChange: (files: AgentCrewFiles) => void
  onOpenChange: (open: boolean) => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Crew files</DialogTitle>
          <DialogDescription>Shared markdown loaded into every agent run.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Tabs
            value={activeFile}
            onValueChange={(value) => onActiveFileChange(value as AgentCrewFileName)}
          >
            <TabsList variant="line" className="flex h-auto flex-wrap justify-start">
              {CREW_FILE_NAMES.map((name) => (
                <TabsTrigger key={name} value={name} className="font-mono text-xs">
                  {name}.md
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">{CREW_HINTS[activeFile]}</p>
          <textarea
            value={files[activeFile]}
            spellCheck={false}
            onChange={(event) => onFilesChange({ ...files, [activeFile]: event.target.value })}
            className="min-h-72 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-6 shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={onSave}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

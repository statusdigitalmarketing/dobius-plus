import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/types'
import {
  ROOT_PROJECT_FILE_NAMES,
  type ProjectFileInfo,
  type ProjectFileName,
  type ProjectFilesListResult
} from '../../../../shared/project-files'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SearchableSetting } from './SearchableSetting'
import { ProjectInstructionFileRow } from './ProjectInstructionFileRow'
import { getProjectInstructionStarter } from './project-instruction-templates'

type RepositoryInstructionsSectionProps = {
  repo: Repo
  forceVisible?: boolean
}

const RULE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyFileList(): ProjectFilesListResult {
  return {
    rootFiles: ROOT_PROJECT_FILE_NAMES.map((name) => ({ name, exists: false, size: 0 })),
    ruleFiles: []
  }
}

function toRuleFileName(ruleName: string): ProjectFileName {
  return `.claude/rules/${ruleName}.md`
}

export function RepositoryInstructionsSection({
  repo,
  forceVisible = false
}: RepositoryInstructionsSectionProps): React.JSX.Element {
  const [files, setFiles] = useState<ProjectFilesListResult>(() => emptyFileList())
  const [loading, setLoading] = useState(true)
  const [ruleName, setRuleName] = useState('')
  const [creatingRule, setCreatingRule] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setFiles(await window.api.projectFiles.list(repo.id))
    } catch (error) {
      toast.error(`Failed to load project instructions: ${getErrorMessage(error)}`)
    } finally {
      setLoading(false)
    }
  }, [repo.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const rootFiles = useMemo(() => {
    const byName = new Map(files.rootFiles.map((file) => [file.name, file]))
    return ROOT_PROJECT_FILE_NAMES.map(
      (name): ProjectFileInfo => byName.get(name) ?? { name, exists: false, size: 0 }
    )
  }, [files.rootFiles])

  const createRule = async (): Promise<void> => {
    const trimmed = ruleName.trim()
    if (!RULE_NAME_PATTERN.test(trimmed)) {
      toast.error('Rule names must start with a letter or number and use letters, numbers, _ or -')
      return
    }
    const fileName = toRuleFileName(trimmed)
    setCreatingRule(true)
    try {
      await window.api.projectFiles.write(
        repo.id,
        fileName,
        getProjectInstructionStarter(fileName, repo.displayName)
      )
      setRuleName('')
      toast.success(`Created ${fileName}`)
      await refresh()
    } catch (error) {
      toast.error(`Failed to create ${fileName}: ${getErrorMessage(error)}`)
    } finally {
      setCreatingRule(false)
    }
  }

  return (
    <SearchableSetting
      title="Project instructions"
      description="Agent context files stored at the project root."
      keywords={[
        repo.displayName,
        'CLAUDE.md',
        'AGENTS.md',
        'instructions',
        'rules',
        'agent context'
      ]}
      className="space-y-4"
      forceVisible={forceVisible}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Project instructions</h3>
          <p className="text-xs text-muted-foreground">
            Edit agent context files committed with this project.
          </p>
        </div>
        {loading ? <Loader2 className="mt-1 size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <div className="space-y-2">
        {rootFiles.map((file) => (
          <ProjectInstructionFileRow
            key={file.name}
            repo={repo}
            file={file}
            canCreate={file.name === 'CLAUDE.md' || file.name === 'AGENTS.md'}
            onChanged={() => void refresh()}
          />
        ))}
      </div>

      <div className="space-y-3 rounded-xl border border-border/50 bg-background/70 px-3 py-3">
        <div className="space-y-1">
          <h4 className="text-sm font-medium">.claude/rules</h4>
          <p className="text-xs text-muted-foreground">
            Optional Claude rule files under this project.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            value={ruleName}
            onChange={(event) => setRuleName(event.target.value)}
            placeholder="rule-name"
            className="h-8 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={creatingRule}
            onClick={() => void createRule()}
          >
            {creatingRule ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add rule
          </Button>
        </div>
        {files.ruleFiles.length > 0 ? (
          <div className="space-y-2">
            {files.ruleFiles.map((file) => (
              <ProjectInstructionFileRow
                key={file.name}
                repo={repo}
                file={file}
                canDelete
                onChanged={() => void refresh()}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">
            No rule files yet.
          </p>
        )}
      </div>
    </SearchableSetting>
  )
}

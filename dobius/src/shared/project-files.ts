export const ROOT_PROJECT_FILE_NAMES = [
  'CLAUDE.md',
  'AGENTS.md',
  'HANDOFF.md',
  'BUILD-LOG.md'
] as const

export type RootProjectFileName = (typeof ROOT_PROJECT_FILE_NAMES)[number]
export type ProjectRuleFileName = `.claude/rules/${string}.md`
export type ProjectFileName = RootProjectFileName | ProjectRuleFileName

export type ProjectFileInfo = {
  name: ProjectFileName
  exists: boolean
  size: number
}

export type ProjectFilesListResult = {
  rootFiles: ProjectFileInfo[]
  ruleFiles: ProjectFileInfo[]
}

export type ProjectFileReadResult = {
  name: ProjectFileName
  content: string
  exists: boolean
}

export type ProjectFileWriteResult = {
  name: ProjectFileName
  size: number
}

export type ProjectFileDeleteResult = {
  name: ProjectFileName
}

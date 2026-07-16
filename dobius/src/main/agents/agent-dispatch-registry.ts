import type { TuiAgent } from '../../shared/types'

export type BuildDispatcher = (req: {
  repoId: string
  name: string
  baseBranch?: string
  brief: string
  buildAgent: TuiAgent
}) => Promise<{ worktreeId: string; ok: boolean; error?: string }>

export type RepoLister = () => { id: string; name: string }[]

let buildDispatcher: BuildDispatcher | null = null
let repoLister: RepoLister | null = null

export function setBuildDispatcher(fn: BuildDispatcher): void {
  buildDispatcher = fn
}

export function getBuildDispatcher(): BuildDispatcher | null {
  return buildDispatcher
}

export function setRepoLister(fn: RepoLister): void {
  repoLister = fn
}

export function getRepoLister(): RepoLister | null {
  return repoLister
}

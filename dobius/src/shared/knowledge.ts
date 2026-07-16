export type KnowledgeLeaf = {
  id: string
  title: string
  summary: string
  filePath: string
  icon: string
  links: string[]
  addedAt: number
}

export type KnowledgeGroup = {
  id: string
  label: string
  leafIds: string[]
}

export type KnowledgeBranch = {
  id: string
  label: string
  sub: string
  leaves: KnowledgeLeaf[]
  groups: KnowledgeGroup[]
  /** Total found before the per-branch cap was applied. */
  totalCount: number
}

export type KnowledgeTree = {
  hubLabel: string
  hubSub: string
  branches: KnowledgeBranch[]
}

export type KnowledgeReadResult = {
  content: string
  filePath: string
}

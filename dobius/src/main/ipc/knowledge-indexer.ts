import { resolve, sep } from 'node:path'
import type { Store } from '../persistence'
import type {
  KnowledgeBranch,
  KnowledgeGroup,
  KnowledgeLeaf,
  KnowledgeTree
} from '../../shared/knowledge'
import {
  claudeDir,
  docsFolderLeaves,
  docsRoot,
  memoryLeaves,
  repoDocLeaves,
  rulesLeaves,
  safeReadDir,
  safeReadFile,
  skillLeaves,
  slugify,
  type LeafDraft
} from './knowledge-leaf-sources'

const MAX_LEAVES_PER_BRANCH = 80
const MAX_GROUPS_PER_BRANCH = 6

export { claudeDir, safeReadDir, safeReadFile }

function resolveLinks(leaves: LeafDraft[]): KnowledgeLeaf[] {
  const bySlug = new Map<string, string>()
  for (const leaf of leaves) {
    bySlug.set(leaf.slug, leaf.id)
    bySlug.set(slugify(leaf.title), leaf.id)
  }
  return leaves.map((draft) => {
    const { content, groupKey: _groupKey, groupLabel: _groupLabel, slug: _slug, ...leaf } = draft
    const links = new Set<string>()
    const text = content ?? ''
    for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const id = bySlug.get(slugify(match[1]))
      if (id && id !== leaf.id) {
        links.add(id)
      }
    }
    const normalizedText = slugify(text)
    for (const [candidateSlug, id] of bySlug) {
      if (id !== leaf.id && candidateSlug && normalizedText.includes(candidateSlug)) {
        links.add(id)
      }
    }
    return { ...leaf, links: [...links].sort() }
  })
}

function buildGroups(drafts: LeafDraft[], visibleLeaves: KnowledgeLeaf[]): KnowledgeGroup[] {
  const visibleIds = new Set(visibleLeaves.map((leaf) => leaf.id))
  const groups = new Map<string, { label: string; ids: string[] }>()
  for (const draft of drafts) {
    if (!visibleIds.has(draft.id)) {
      continue
    }
    const group = groups.get(draft.groupKey) ?? { label: draft.groupLabel, ids: [] }
    group.ids.push(draft.id)
    groups.set(draft.groupKey, group)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length)
  const singles = sorted.filter(([, group]) => group.ids.length === 1)
  const multi = sorted.filter(([, group]) => group.ids.length > 1)
  const keep = multi.slice(0, MAX_GROUPS_PER_BRANCH - 1)
  const merge = [...multi.slice(MAX_GROUPS_PER_BRANCH - 1), ...singles]
  const result = keep.map(([id, group]) => ({
    id: slugify(id),
    label: group.label,
    leafIds: group.ids.sort()
  }))
  if (merge.length > 0) {
    result.push({
      id: 'assorted',
      label: 'assorted',
      leafIds: merge.flatMap(([, group]) => group.ids).sort()
    })
  }
  return result
}

function branch(
  id: string,
  label: string,
  sub: string,
  drafts: LeafDraft[],
  allLeaves: KnowledgeLeaf[]
): KnowledgeBranch {
  const leafById = new Map(allLeaves.map((leaf) => [leaf.id, leaf]))
  const leaves = drafts
    .map((draft) => leafById.get(draft.id))
    .filter((leaf): leaf is KnowledgeLeaf => Boolean(leaf))
    .slice(0, MAX_LEAVES_PER_BRANCH)
  return {
    id,
    label,
    sub,
    leaves,
    groups: buildGroups(drafts, leaves),
    totalCount: drafts.length
  }
}

function draftsByBranch(store: Store): [string, string, string, LeafDraft[]][] {
  return [
    ['learned', 'Learned', 'minted from real failures', skillLeaves(true)],
    ['skills', 'Skills', 'how-to playbooks', skillLeaves(false)],
    ['memory', 'Memory', 'facts that persist', memoryLeaves()],
    [
      'lessons',
      'Lessons',
      'per-project scar tissue',
      repoDocLeaves(store, 'lessons', ['LESSONS-LEARNED.md'])
    ],
    ['docs', 'Docs', 'task records', docsFolderLeaves()],
    ['rules', 'Rules', 'house rules · gates', rulesLeaves()],
    [
      'projects',
      'Projects',
      'per-repo context',
      repoDocLeaves(store, 'projects', ['CLAUDE.md', 'AGENTS.md', 'HANDOFF.md', 'BUILD-LOG.md'])
    ]
  ]
}

export function buildKnowledgeTree(store: Store): KnowledgeTree {
  const branchDrafts = draftsByBranch(store)
  const allLeaves = resolveLinks(branchDrafts.flatMap(([, , , drafts]) => drafts))
  return {
    hubLabel: 'Knowledge',
    hubSub: 'everything the system knows',
    branches: branchDrafts.map(([id, label, sub, drafts]) =>
      branch(id, label, sub, drafts, allLeaves)
    )
  }
}

export function isAllowedKnowledgePath(filePath: string, store: Store): boolean {
  const resolved = resolve(filePath)
  if (!resolved.endsWith('.md')) {
    return false
  }
  const roots = [claudeDir(), docsRoot(), ...store.getRepos().map((repo) => repo.path)]
  return roots.some(
    (root) => resolved.startsWith(`${resolve(root)}${sep}`) || resolved === resolve(root)
  )
}

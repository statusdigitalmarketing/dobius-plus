import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import type { Store } from '../persistence'
import type { KnowledgeLeaf } from '../../shared/knowledge'

const MAX_READ_BYTES = 512 * 1024

export type LeafDraft = Omit<KnowledgeLeaf, 'links'> & {
  content: string | null
  groupKey: string
  groupLabel: string
  slug: string
}

export function claudeDir(): string {
  return join(homedir(), '.claude')
}

export function docsRoot(): string {
  return join(homedir(), 'Projects (Code)', 'Docs')
}

export function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function safeReadFile(filePath: string, maxBytes = MAX_READ_BYTES): string | null {
  try {
    if (statSync(filePath).size > maxBytes) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

function safeMtime(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function extractSummary(content: string | null): string {
  if (!content) {
    return ''
  }
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)
  const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1]
  if (description) {
    return description.replace(/^['"]|['"]$/g, '').slice(0, 180)
  }
  const body = content.replace(/^---\n[\s\S]*?\n---/, '').trim()
  const firstLine = body.split('\n').find((line) => line.trim() && !line.startsWith('#'))
  return (firstLine ?? '').trim().slice(0, 180)
}

function titleFromMarkdown(content: string | null, fallback: string): string {
  const heading = content?.match(/^#\s+(.+)$/m)?.[1]
  return (heading ?? fallback).trim().slice(0, 80)
}

function humanize(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\.md$/i, '')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function prefixFamily(name: string): string | null {
  const normalized = name.replace(/^learned-/, '')
  const dash = normalized.indexOf('-')
  return dash > 0 ? normalized.slice(0, dash) : null
}

function iconForLeaf(branchId: string, title: string, filePath: string): string {
  const haystack = `${branchId} ${title} ${basename(filePath)}`.toLowerCase()
  const keywordIcons: [string[], string][] = [
    [['mail', 'email', 'inbox'], 'mail'],
    [['git', 'commit', 'branch'], 'git-branch'],
    [['test', 'spec', 'verify'], 'flask-conical'],
    [['deploy', 'ship', 'release'], 'rocket'],
    [['review', 'audit'], 'search-check'],
    [['memory'], 'database'],
    [['rule', 'policy'], 'scale'],
    [['doc', 'markdown'], 'file-text']
  ]
  for (const [keywords, icon] of keywordIcons) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return icon
    }
  }
  if (branchId === 'skills') {
    return 'sparkles'
  }
  if (branchId === 'learned') {
    return 'graduation-cap'
  }
  const fallback = ['book-open', 'brain', 'boxes', 'compass', 'file-text', 'folder', 'landmark', 'lightbulb', 'map', 'network', 'notebook-tabs', 'workflow']
  return fallback[hashString(filePath) % fallback.length]
}

function leafDraft(
  branchId: string,
  filePath: string,
  title: string,
  summary: string,
  groupKey: string,
  groupLabel: string,
  content: string | null
): LeafDraft {
  return {
    id: filePath,
    title,
    summary,
    filePath,
    icon: iconForLeaf(branchId, title, filePath),
    addedAt: safeMtime(filePath),
    content,
    groupKey,
    groupLabel,
    slug: slugify(basename(filePath))
  }
}

export function skillLeaves(filterLearned: boolean): LeafDraft[] {
  const skillsDir = join(claudeDir(), 'skills')
  const entries = safeReadDir(skillsDir)
  const familyCounts = new Map<string, number>()
  for (const entry of entries) {
    const family = prefixFamily(entry)
    if (family) {
      familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1)
    }
  }
  const branchId = filterLearned ? 'learned' : 'skills'
  const result: LeafDraft[] = []
  for (const entry of entries) {
    const isLearned = entry.startsWith('learned-')
    if (isLearned !== filterLearned) {
      continue
    }
    const skillFile = join(skillsDir, entry, 'SKILL.md')
    if (!existsSync(skillFile)) {
      continue
    }
    const family = prefixFamily(entry)
    const group = family && (familyCounts.get(family) ?? 0) >= 2 ? family : entry
    const content = safeReadFile(skillFile)
    result.push(
      leafDraft(
        branchId,
        skillFile,
        humanize(filterLearned ? entry.replace(/^learned-/, '') : entry),
        extractSummary(content),
        group,
        humanize(group),
        content
      )
    )
  }
  return result.sort((a, b) => a.title.localeCompare(b.title))
}

export function memoryLeaves(): LeafDraft[] {
  const projectsDir = join(claudeDir(), 'projects')
  const result: LeafDraft[] = []
  for (const project of safeReadDir(projectsDir)) {
    const memoryDir = join(projectsDir, project, 'memory')
    for (const file of safeReadDir(memoryDir)) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') {
        continue
      }
      const filePath = join(memoryDir, file)
      const content = safeReadFile(filePath)
      result.push(
        leafDraft(
          'memory',
          filePath,
          titleFromMarkdown(content, humanize(file)),
          extractSummary(content),
          project,
          humanize(project),
          content
        )
      )
    }
  }
  return result
}

export function repoDocLeaves(store: Store, branchId: string, fileNames: string[]): LeafDraft[] {
  const result: LeafDraft[] = []
  for (const repo of store.getRepos()) {
    for (const fileName of fileNames) {
      const filePath = join(repo.path, fileName)
      if (!existsSync(filePath)) {
        continue
      }
      const content = safeReadFile(filePath)
      result.push(
        leafDraft(
          branchId,
          filePath,
          `${basename(repo.path)} · ${fileName.replace(/\.md$/, '')}`,
          extractSummary(content),
          basename(repo.path),
          basename(repo.path),
          content
        )
      )
    }
  }
  return result
}

export function docsFolderLeaves(): LeafDraft[] {
  const root = docsRoot()
  const result: LeafDraft[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) {
      return
    }
    for (const entry of safeReadDir(dir)) {
      if (entry.startsWith('.')) {
        continue
      }
      const fullPath = join(dir, entry)
      try {
        if (statSync(fullPath).isDirectory()) {
          walk(fullPath, depth + 1)
        } else if (entry.endsWith('.md')) {
          const rel = relative(root, fullPath)
          const firstFolder = rel.includes(sep) ? rel.split(sep)[0] : 'root'
          const content = safeReadFile(fullPath)
          result.push(
            leafDraft(
              'docs',
              fullPath,
              humanize(entry),
              extractSummary(content),
              firstFolder,
              humanize(firstFolder),
              content
            )
          )
        }
      } catch {
        // unreadable entry — skip
      }
    }
  }
  walk(root, 0)
  return result
}

export function rulesLeaves(): LeafDraft[] {
  const candidates = [join(claudeDir(), 'CLAUDE.md'), join(claudeDir(), 'SKILLS-HOOKS-AGENTS.md'), join(claudeDir(), 'skills', 'LEARNED.md')]
  return candidates
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => {
      const content = safeReadFile(filePath)
      return leafDraft(
        'rules',
        filePath,
        titleFromMarkdown(content, humanize(basename(filePath))),
        extractSummary(content),
        'house-rules',
        'house rules',
        content
      )
    })
}

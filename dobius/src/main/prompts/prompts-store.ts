import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { DobiusPrompt } from '../../shared/prompts'

// Reusable prompt snippets, self-owned JSON in userData (out of GlobalSettings,
// same atomic tmp+rename pattern as the Asana config).
const FILE_NAME = 'prompts.json'
let cached: DobiusPrompt[] | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function sanitize(raw: unknown): DobiusPrompt[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const record = entry as Partial<Record<keyof DobiusPrompt, unknown>>
    const id = typeof record.id === 'string' ? record.id : ''
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const text = typeof record.text === 'string' ? record.text : ''
    const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
    if (!id || !title || !text) {
      return []
    }
    return [{ id, title, text, createdAt }]
  })
}

function load(): DobiusPrompt[] {
  if (cached) {
    return cached
  }
  try {
    cached = sanitize(JSON.parse(readFileSync(filePath(), 'utf-8')))
  } catch {
    cached = []
  }
  return cached
}

function persist(prompts: DobiusPrompt[]): void {
  const target = filePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(prompts, null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[prompts] failed to persist:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function listPrompts(): DobiusPrompt[] {
  return load().map((p) => ({ ...p }))
}

export function savePrompt(input: { id?: string; title: string; text: string }): DobiusPrompt[] {
  const title = input.title.trim()
  const text = input.text
  if (!title || !text.trim()) {
    return listPrompts()
  }
  const prompts = load()
  const existing = input.id ? prompts.find((p) => p.id === input.id) : undefined
  if (existing) {
    existing.title = title
    existing.text = text
  } else {
    prompts.push({
      id: `prompt-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      title,
      text,
      createdAt: Date.now()
    })
  }
  cached = prompts
  persist(prompts)
  return listPrompts()
}

export function deletePrompt(id: string): DobiusPrompt[] {
  cached = load().filter((p) => p.id !== id)
  persist(cached)
  return listPrompts()
}

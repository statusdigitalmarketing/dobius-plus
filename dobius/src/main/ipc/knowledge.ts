import { app, ipcMain, webContents } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../persistence'
import type { KnowledgeReadResult, KnowledgeTree } from '../../shared/knowledge'
import {
  buildKnowledgeTree,
  claudeDir,
  isAllowedKnowledgePath,
  safeReadDir,
  safeReadFile
} from './knowledge-indexer'

const WATCH_DEBOUNCE_MS = 1500

let knowledgeWatchers: FSWatcher[] = []
let watchDebounce: NodeJS.Timeout | null = null
let watchingKnowledge = false

function notifyKnowledgeChanged(): void {
  if (watchDebounce) {
    clearTimeout(watchDebounce)
  }
  watchDebounce = setTimeout(() => {
    for (const contents of webContents.getAllWebContents()) {
      // Why: the debounce can outlive a window — sending to destroyed
      // webContents throws and would take down the whole main process.
      if (!contents.isDestroyed()) {
        contents.send('knowledge:changed')
      }
    }
  }, WATCH_DEBOUNCE_MS)
}

function watchPath(pathValue: string): void {
  if (!existsSync(pathValue)) {
    return
  }
  try {
    knowledgeWatchers.push(watch(pathValue, { recursive: true }, notifyKnowledgeChanged))
  } catch {
    try {
      knowledgeWatchers.push(watch(pathValue, notifyKnowledgeChanged))
    } catch {
      // Why: SSH and network-mounted knowledge roots may not support fs.watch.
    }
  }
}

function disposeKnowledgeWatchers(): void {
  for (const watcher of knowledgeWatchers) {
    watcher.close()
  }
  knowledgeWatchers = []
  watchingKnowledge = false
}

function startKnowledgeWatchers(): void {
  if (watchingKnowledge) {
    return
  }
  watchingKnowledge = true
  watchPath(join(claudeDir(), 'skills'))
  const projectsDir = join(claudeDir(), 'projects')
  for (const project of safeReadDir(projectsDir)) {
    watchPath(join(projectsDir, project, 'memory'))
  }
  app.once('before-quit', disposeKnowledgeWatchers)
}

export function registerKnowledgeHandlers(store: Store): void {
  ipcMain.handle('knowledge:tree', async (): Promise<KnowledgeTree> => buildKnowledgeTree(store))
  ipcMain.handle('knowledge:watch', async (): Promise<void> => startKnowledgeWatchers())

  ipcMain.handle(
    'knowledge:read',
    async (_event, filePath: string): Promise<KnowledgeReadResult> => {
      if (typeof filePath !== 'string' || !isAllowedKnowledgePath(filePath, store)) {
        throw new Error('Path is outside the knowledge roots.')
      }
      const content = safeReadFile(filePath)
      if (content === null) {
        throw new Error('Could not read the knowledge file.')
      }
      return { content, filePath }
    }
  )
}

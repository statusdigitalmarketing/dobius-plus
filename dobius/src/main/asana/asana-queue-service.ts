import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { AsanaTask, AsanaTasksSnapshot } from '../../shared/asana'
import { ASANA_GID_RE, EMPTY_ASANA_SNAPSHOT } from '../../shared/asana'
import { getAsanaConfig } from './asana-config'
import { hasAsanaToken } from './asana-token-store'
import { fetchLane, markTaskComplete } from './asana-client'

// Locally-ticked task gids live in their own JSON so ticking a task "done" in
// the panel never touches Asana (house rule: never auto-close Asana tasks).
const LOCAL_DONE_FILE = 'asana-local-done.json'

let buildTasks: AsanaTask[] = []
let reviewTasks: AsanaTask[] = []
let lastSync: number | null = null
let lastError: string | null = null
let localDone: Set<string> | null = null
let refreshing = false

function localDonePath(): string {
  return path.join(app.getPath('userData'), LOCAL_DONE_FILE)
}

function loadLocalDone(): Set<string> {
  if (localDone) {
    return localDone
  }
  try {
    const raw = JSON.parse(readFileSync(localDonePath(), 'utf-8'))
    localDone = new Set(Array.isArray(raw) ? raw.filter((g) => typeof g === 'string') : [])
  } catch {
    localDone = new Set()
  }
  return localDone
}

function persistLocalDone(): void {
  const target = localDonePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify([...loadLocalDone()], null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[asana] failed to persist local-done:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function getAsanaSnapshot(): AsanaTasksSnapshot {
  if (!hasAsanaToken()) {
    return { ...EMPTY_ASANA_SNAPSHOT }
  }
  return {
    build: buildTasks,
    review: reviewTasks,
    localDone: [...loadLocalDone()],
    lastSync,
    error: lastError
  }
}

function broadcast(): void {
  const snapshot = getAsanaSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('asana:tasksUpdated', snapshot)
    }
  }
}

/** Refetch both lanes and push the new snapshot to the renderer. */
export async function refreshAsanaTasks(): Promise<AsanaTasksSnapshot> {
  if (!hasAsanaToken()) {
    return getAsanaSnapshot()
  }
  if (refreshing) {
    return getAsanaSnapshot()
  }
  refreshing = true
  try {
    const { myGid, reviewGid } = getAsanaConfig()
    const [build, review] = await Promise.all([
      fetchLane('build', myGid).catch((e) => {
        throw e
      }),
      fetchLane('review', reviewGid)
    ])
    buildTasks = build
    reviewTasks = review
    lastSync = Date.now()
    lastError = null
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  } finally {
    refreshing = false
  }
  broadcast()
  return getAsanaSnapshot()
}

/** Tick a task done in the panel only — does NOT call Asana. */
export function markLocalDone(gid: string): AsanaTasksSnapshot {
  if (ASANA_GID_RE.test(gid)) {
    loadLocalDone().add(gid)
    persistLocalDone()
    broadcast()
  }
  return getAsanaSnapshot()
}

export function clearLocalDone(gid: string): AsanaTasksSnapshot {
  if (loadLocalDone().delete(gid)) {
    persistLocalDone()
    broadcast()
  }
  return getAsanaSnapshot()
}

/** The single Asana write — completes the task in Asana. User-triggered only. */
export async function completeAsanaTask(gid: string): Promise<AsanaTasksSnapshot> {
  await markTaskComplete(gid)
  markLocalDone(gid)
  // reflect the completion locally without a full refetch round-trip
  buildTasks = buildTasks.filter((t) => t.gid !== gid)
  reviewTasks = reviewTasks.map((t) => (t.gid === gid ? { ...t, completed: true } : t))
  broadcast()
  return getAsanaSnapshot()
}

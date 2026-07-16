// work-registry.ts — Phase 3 leaf module of the Voice Conductor port.
//
// In-memory backing store for the dobius-track / dobius-status / dobius-mark-done
// CLIs: the conductor tracks a dispatched job here, later queries its status or
// marks it done. Pure and deterministic — no Electron, IO, persistence, or
// notification side effects. The v1 reference (electron/work-registry.js) also
// persisted to config, watched tabs, fired iMessage final-reports, and enforced
// concurrency caps; all of that belongs to the CLI / dispatch layers, not here.

import type { WorkItem, WorkRegistry } from './types'

export function createWorkRegistry(options?: {
  initialItems?: readonly WorkItem[]
  onChange?: (items: readonly WorkItem[]) => void
  now?: () => number
}): WorkRegistry {
  const items = new Map<string, WorkItem>(
    options?.initialItems?.map((item) => [item.workId, { ...item }]) ?? []
  )
  const now = options?.now ?? Date.now

  function publish(): void {
    options?.onChange?.(Array.from(items.values(), (item) => ({ ...item })))
  }

  function track(item: Pick<WorkItem, 'workId' | 'tabId' | 'requestId' | 'description'>): void {
    items.set(item.workId, {
      workId: item.workId,
      tabId: item.tabId,
      requestId: item.requestId,
      description: item.description,
      startedAt: now(),
      status: 'running',
    })
    publish()
  }

  function status(target?: string): WorkItem[] {
    const all = Array.from(items.values())
    if (!target) {return all}
    const q = target.toLowerCase()
    return all.filter(
      (e) =>
        e.workId.toLowerCase().includes(q) ||
        e.tabId.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q),
    )
  }

  function markDone(
    workId: string,
    summary: string,
    status: 'done' | 'error' = 'done',
  ): WorkItem | null {
    const entry = items.get(workId)
    if (!entry) {return null}
    entry.summary = summary
    entry.status = status
    publish()
    return { ...entry }
  }

  function list(): WorkItem[] {
    return Array.from(items.values(), (item) => ({ ...item }))
  }

  return { track, status, markDone, list }
}

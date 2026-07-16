import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPersistentWorkRegistry } from './persistent-work-registry'

describe('persistent Voice Conductor work registry', () => {
  it('restores tracked work and completion state after restart', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dobius-conductor-work-'))
    const filePath = path.join(root, 'work.json')
    const registry = createPersistentWorkRegistry(filePath)
    registry.track({
      workId: 'wk-1',
      tabId: 'run-1',
      requestId: 'req-1',
      description: 'Review the change'
    })
    registry.markDone('wk-1', 'Passed review')

    expect(createPersistentWorkRegistry(filePath).list()).toMatchObject([
      { workId: 'wk-1', tabId: 'run-1', status: 'done', summary: 'Passed review' }
    ])
  })

  it('ignores malformed persisted rows', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dobius-conductor-work-'))
    const filePath = path.join(root, 'work.json')
    const registry = createPersistentWorkRegistry(filePath)

    expect(registry.list()).toEqual([])
  })
})

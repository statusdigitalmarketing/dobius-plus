import { describe, expect, it } from 'vitest'
import {
  asanaTaskToQueueTask,
  createAsanaQueue,
  summarizeQueueTasks,
  type AsanaApiTask,
  type LaneAssignees
} from './asana-queue'

const LANES: LaneAssignees = { buildGid: '111build', reviewGid: '222review' }

describe('asanaTaskToQueueTask', () => {
  it('classifies a Carson-assigned task as lane build', () => {
    const task: AsanaApiTask = {
      gid: 'T1',
      name: 'Add cost tracker column',
      notes: 'Sum the daily spend.',
      assignee: { gid: '111build' }
    }
    expect(asanaTaskToQueueTask(task, LANES)).toEqual({
      gid: 'T1',
      title: 'Add cost tracker column',
      notes: 'Sum the daily spend.',
      lane: 'build'
    })
  })

  it('classifies a Sam-assigned task as lane review', () => {
    const task: AsanaApiTask = {
      gid: 'T2',
      name: 'Fix lifestyle 03 typo',
      notes: '',
      assignee: { gid: '222review' }
    }
    expect(asanaTaskToQueueTask(task, LANES)).toEqual({
      gid: 'T2',
      title: 'Fix lifestyle 03 typo',
      notes: '',
      lane: 'review'
    })
  })

  it('returns null for a task assigned outside both lanes', () => {
    const task: AsanaApiTask = { gid: 'T3', name: 'Someone else', assignee: { gid: '999other' } }
    expect(asanaTaskToQueueTask(task, LANES)).toBeNull()
  })

  it('returns null for an unassigned task', () => {
    const task: AsanaApiTask = { gid: 'T4', name: 'No assignee', assignee: null }
    expect(asanaTaskToQueueTask(task, LANES)).toBeNull()
  })

  it('falls back to (untitled) and empty notes when absent', () => {
    const task: AsanaApiTask = { gid: 'T5', assignee: { gid: '111build' } }
    expect(asanaTaskToQueueTask(task, LANES)).toEqual({
      gid: 'T5',
      title: '(untitled)',
      notes: '',
      lane: 'build'
    })
  })
})

describe('summarizeQueueTasks', () => {
  it('counts each lane into a short human string', () => {
    const tasks = [
      { gid: 'a', title: 'a', notes: '', lane: 'build' as const },
      { gid: 'b', title: 'b', notes: '', lane: 'build' as const },
      { gid: 'c', title: 'c', notes: '', lane: 'build' as const },
      { gid: 'd', title: 'd', notes: '', lane: 'review' as const }
    ]
    expect(summarizeQueueTasks(tasks)).toBe('3 build, 1 review')
  })

  it('reports zeros for an empty queue', () => {
    expect(summarizeQueueTasks([])).toBe('0 build, 0 review')
  })
})

describe('createAsanaQueue.fetch', () => {
  it('maps + classifies via an injected lister (no network) and summarizes', async () => {
    const fakeTasks: AsanaApiTask[] = [
      { gid: 'T1', name: 'Build A', notes: 'do a', assignee: { gid: '111build' } },
      { gid: 'T2', name: 'Review B', notes: 'check b', assignee: { gid: '222review' } },
      { gid: 'T3', name: 'Not mine', notes: '', assignee: { gid: '999other' } }
    ]
    const queue = createAsanaQueue({
      ...LANES,
      listTasks: async () => fakeTasks
    })
    const { tasks, summary } = await queue.fetch('projectGid')
    expect(tasks).toEqual([
      { gid: 'T1', title: 'Build A', notes: 'do a', lane: 'build' },
      { gid: 'T2', title: 'Review B', notes: 'check b', lane: 'review' }
    ])
    expect(summary).toBe('1 build, 1 review')
  })
})

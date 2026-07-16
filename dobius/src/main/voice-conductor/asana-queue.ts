import type { AsanaLane, AsanaQueue, AsanaQueueTask } from './types'

// Phase 6 — Asana queue (v1 electron/asana-queue.js ported to the v2 main
// process). Fetches assigned Asana tasks and classifies each into a LANE:
//   - build  → assigned to Carson (buildGid). We build these end-to-end.
//   - review → assigned to Sam (reviewGid). We only double-check his work.
//
// The lane split mirrors the workspace house rules. Anything assigned to
// neither gid is not in a lane and is dropped.
//
// TOKEN SOURCE: the Asana Personal Access Token defaults to the ASANA_PAT
// environment variable (v1 read the same var — see v1 lines 66-69), and can be
// overridden via config.token. The build/review gids are NOT hardcoded here;
// they must be supplied by config (v1 kept defaults in config-manager, which
// this module deliberately leaves to the caller so no gid is baked into source).

const ASANA_BASE_URL = 'https://app.asana.com/api/1.0'
const ASANA_TIMEOUT_MS = 10_000
const MAX_TASKS_PER_FETCH = 25
// Only these fields are needed to build an AsanaQueueTask + classify its lane.
const TASK_FIELDS = 'gid,name,notes,assignee'

/** The compact Asana REST task record we consume (subset of the full object). */
export type AsanaApiTask = {
  gid: string
  name?: string | null
  notes?: string | null
  assignee?: { gid?: string | null } | null
}

/** Maps a lane assignee gid to its lane label. */
export type LaneAssignees = {
  buildGid: string
  reviewGid: string
}

/**
 * Lists the raw Asana task records for a queue. Pluggable so the mapping logic
 * is testable without a network (mirrors the manager sources' lister seam).
 */
export type AsanaTaskLister = (queue: string) => Promise<AsanaApiTask[]>

export type AsanaQueueConfig = LaneAssignees & {
  /** Asana PAT. Defaults to process.env.ASANA_PAT when omitted. */
  token?: string
  /** Override the network lister — defaults to the real Asana REST call. */
  listTasks?: AsanaTaskLister
  /** Override the API base (tests / self-hosted proxies). */
  baseUrl?: string
}

/**
 * Classify a single Asana API task into a queue task, or null if its assignee
 * is in neither lane. Pure: no network, no config globals — the unit under test.
 */
export function asanaTaskToQueueTask(
  task: AsanaApiTask,
  lanes: LaneAssignees
): AsanaQueueTask | null {
  const assigneeGid = task.assignee?.gid
  let lane: AsanaLane
  if (assigneeGid && assigneeGid === lanes.buildGid) {lane = 'build'}
  else if (assigneeGid && assigneeGid === lanes.reviewGid) {lane = 'review'}
  else {return null}
  return {
    gid: task.gid,
    title: task.name || '(untitled)',
    notes: task.notes || '',
    lane
  }
}

/** "3 build, 1 review" — a short human summary of the classified tasks. */
export function summarizeQueueTasks(tasks: AsanaQueueTask[]): string {
  const build = tasks.filter((t) => t.lane === 'build').length
  const review = tasks.filter((t) => t.lane === 'review').length
  return `${build} build, ${review} review`
}

function resolveToken(config: AsanaQueueConfig): string {
  const token = config.token || process.env.ASANA_PAT
  if (!token) {throw new Error('ASANA_PAT not set (env or config.token)')}
  return token
}

/**
 * Default lister: GET the incomplete tasks for a project queue. `queue` is the
 * project gid; assignee is fetched per task and classified client-side because
 * Asana rejects project + assignee in the same query.
 */
function createRestLister(config: AsanaQueueConfig): AsanaTaskLister {
  const baseUrl = config.baseUrl || ASANA_BASE_URL
  return async (queue: string): Promise<AsanaApiTask[]> => {
    const token = resolveToken(config)
    // ponytail: single page capped at MAX_TASKS_PER_FETCH — a voice-driven queue
    // rarely exceeds it. If queues grow past the cap, follow Asana's
    // response `next_page.offset` here instead of dropping the overflow.
    const params = new URLSearchParams({
      project: queue,
      completed_since: 'now', // 'now' returns only still-incomplete tasks
      limit: String(MAX_TASKS_PER_FETCH),
      opt_fields: TASK_FIELDS
    })
    const res = await fetch(`${baseUrl}/tasks?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ASANA_TIMEOUT_MS)
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      throw new Error(`Asana HTTP ${res.status}: ${body}`)
    }
    const json = (await res.json()) as { data?: AsanaApiTask[] }
    return json.data ?? []
  }
}

export function createAsanaQueue(config: AsanaQueueConfig): AsanaQueue {
  const listTasks = config.listTasks ?? createRestLister(config)
  const lanes: LaneAssignees = { buildGid: config.buildGid, reviewGid: config.reviewGid }
  return {
    async fetch(queue: string) {
      const raw = await listTasks(queue)
      const tasks: AsanaQueueTask[] = []
      for (const t of raw) {
        const mapped = asanaTaskToQueueTask(t, lanes)
        if (mapped) {tasks.push(mapped)} // drop tasks assigned outside both lanes
      }
      return { tasks, summary: summarizeQueueTasks(tasks) }
    }
  }
}

import https from 'node:https'
import type { AsanaLane, AsanaTask } from '../../shared/asana'
import { ASANA_GID_RE } from '../../shared/asana'
import { getAsanaToken } from './asana-token-store'

// Wire-level facts copied from the old dobius-plus asana-queue.js / tasks-service.js:
// query by assignee + workspace (Asana allows those together, unlike project+assignee),
// then read the fields the Tasks panel shows.
const ASANA_HOST = 'app.asana.com'
const TIMEOUT_MS = 15_000
const MAX_TASKS = 50
const ASANA_STORY_TEXT_LIMIT = 65_000
const REVIEW_WINDOW_MS = 48 * 60 * 60 * 1000
const TASK_FIELDS = 'gid,name,due_on,completed,permalink_url,assignee.name,notes'

function asanaGet<T>(path: string): Promise<T> {
  const token = getAsanaToken() // main-process only; throws if not configured
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: ASANA_HOST,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeout: TIMEOUT_MS
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          const code = res.statusCode ?? 0
          if (code < 200 || code >= 300) {
            reject(new Error(`Asana HTTP ${code}: ${raw.slice(0, 200)}`))
            return
          }
          try {
            resolve(raw ? (JSON.parse(raw) as T) : ({} as T))
          } catch {
            reject(new Error('Asana returned invalid JSON'))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Asana request timed out')))
    req.end()
  })
}

function asanaPost<T>(path: string, body: unknown): Promise<T> {
  const token = getAsanaToken() // main-process only; throws if not configured
  const payload = JSON.stringify(body)
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: ASANA_HOST,
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: TIMEOUT_MS
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          const code = res.statusCode ?? 0
          if (code < 200 || code >= 300) {
            reject(new Error(`Asana HTTP ${code}: ${raw.slice(0, 200)}`))
            return
          }
          try {
            resolve(raw ? (JSON.parse(raw) as T) : ({} as T))
          } catch {
            reject(new Error('Asana returned invalid JSON'))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Asana request timed out')))
    req.end(payload)
  })
}

type MeResponse = { data?: { gid?: string; workspaces?: { gid: string }[] } }
type TasksResponse = {
  data?: {
    gid: string
    name?: string
    notes?: string | null
    due_on?: string | null
    completed?: boolean
    permalink_url?: string
    assignee?: { name?: string } | null
  }[]
}

async function fetchWorkspaces(): Promise<string[]> {
  const me = await asanaGet<MeResponse>('/api/1.0/users/me?opt_fields=gid,workspaces')
  return (me.data?.workspaces ?? []).map((w) => w.gid).filter(Boolean)
}

/**
 * Fetch a lane's tasks by assignee across all the token owner's workspaces.
 * build lane = incomplete tasks; review lane = tasks modified in the last 48h,
 * keeping only completed ones (Sam's recently-finished work).
 */
export async function fetchLane(lane: AsanaLane, assigneeGid: string): Promise<AsanaTask[]> {
  if (!ASANA_GID_RE.test(assigneeGid)) {
    return []
  }
  const workspaces = await fetchWorkspaces()
  const seen = new Set<string>()
  const out: AsanaTask[] = []
  for (const ws of workspaces) {
    const recent =
      lane === 'review'
        ? `&modified_since=${encodeURIComponent(new Date(Date.now() - REVIEW_WINDOW_MS).toISOString())}`
        : ''
    const path =
      `/api/1.0/tasks?assignee=${assigneeGid}&workspace=${ws}` +
      `&completed_since=now&limit=${MAX_TASKS}&opt_fields=${TASK_FIELDS}${recent}`
    const res = await asanaGet<TasksResponse>(path)
    for (const t of res.data ?? []) {
      if (!t.gid || seen.has(t.gid)) {
        continue
      }
      if (lane === 'review' && !t.completed) {
        continue
      }
      seen.add(t.gid)
      out.push({
        gid: t.gid,
        name: t.name || '(untitled)',
        notes: t.notes ?? '',
        url: t.permalink_url || `https://app.asana.com/0/0/${t.gid}`,
        dueOn: t.due_on ?? null,
        completed: Boolean(t.completed),
        lane,
        assignee: t.assignee?.name ?? null
      })
    }
  }
  return out
}

/**
 * User-triggered Asana completion write. PUT /tasks/<gid> {completed:true}. Only ever called
 * from an explicit user action — never from the poller or the local-done tick.
 */
export async function markTaskComplete(taskGid: string): Promise<void> {
  if (!ASANA_GID_RE.test(taskGid)) {
    throw new Error('Asana task gid malformed')
  }
  const token = getAsanaToken()
  const payload = JSON.stringify({ data: { completed: true } })
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: ASANA_HOST,
        path: `/api/1.0/tasks/${taskGid}`,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: TIMEOUT_MS
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          const code = res.statusCode ?? 0
          if (code >= 200 && code < 300) {
            resolve()
          } else {
            reject(new Error(`Asana HTTP ${code}: ${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('Asana request timed out')))
    req.end(payload)
  })
}

type StoryResponse = { data?: { gid?: string } }

function truncateStoryText(text: string): string {
  if (text.length <= ASANA_STORY_TEXT_LIMIT) {
    return text
  }
  const suffix = '\n\n[Comment truncated by Dobius+ to fit Asana story limits.]'
  return `${text.slice(0, ASANA_STORY_TEXT_LIMIT - suffix.length)}${suffix}`
}

export async function postTaskComment(taskGid: string, text: string): Promise<{ gid: string }> {
  if (!ASANA_GID_RE.test(taskGid)) {
    throw new Error('Asana task gid malformed')
  }
  const response = await asanaPost<StoryResponse>(`/api/1.0/tasks/${taskGid}/stories`, {
    data: { text: truncateStoryText(text) }
  })
  const gid = response.data?.gid
  if (!gid) {
    throw new Error('Asana did not return a story gid')
  }
  return { gid }
}

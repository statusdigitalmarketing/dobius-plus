// Pure request routing for the Voice Conductor CLI server (socket-free,
// unit-testable). Split out of cli-server.ts to keep both modules under the
// max-lines limit; cli-server.ts owns the socket plumbing and re-exports this.
import type { WorkItem } from './types'
import type { ConductorCliDeps, ConductorCliResult } from './cli-server'

// --- pure request routing (socket-free, unit-testable) ------------------

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// Reject any control NUL: it would poison a downstream execFile/spawn arg
// (documented Dobius+ rule) and can never be a legitimate CLI value.
function hasNullByte(value: string): boolean {
  return value.includes('\u0000')
}

const REQUEST_ID_RE = /^[a-zA-Z0-9-]{4,80}$/

// WorkRegistry exposes typed items but no formatter; the CLI wants a single
// iMessage-friendly line per item (v1's formatStatusSnapshot lived in
// work-registry.js). Keep it terse — this string is spoken/texted back.
function formatWorkSnapshot(items: WorkItem[]): string {
  if (items.length === 0) {
    return 'No tracked work.'
  }
  const now = Date.now()
  return items
    .map((item) => {
      const mins = Math.max(0, Math.round((now - item.startedAt) / 60_000))
      const tail = item.summary ? ` — ${item.summary}` : ''
      return `${item.workId} • ${mins}m • ${item.description} [${item.status}]${tail}`
    })
    .join('\n')
}

// v1's dobius-mark-done spoke "completed|failed|cancelled"; the v2 WorkRegistry
// contract is 'done' | 'error'. Map onto it, defaulting to 'done'.
function toRegistryStatus(raw: string): 'done' | 'error' {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'error' || normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'error'
  }
  return 'done'
}

/**
 * Route one parsed request. Pure: no sockets, no module I/O beyond the injected
 * deps — the test drives this directly with fake deps and an `authorized` flag.
 */
export async function handleConductorCliRequest(
  url: string,
  body: Record<string, unknown>,
  ctx: { authorized: boolean; deps: ConductorCliDeps }
): Promise<ConductorCliResult> {
  if (!ctx.authorized) {
    return { status: 401, body: { ok: false, error: 'unauthorized' } }
  }
  const { deps: d } = ctx
  try {
    switch (url) {
      case '/tabSend': {
        const tabId = asString(body.tabId)
        const message = asString(body.message)
        if (!tabId.trim() || hasNullByte(tabId)) {
          return { status: 400, body: { ok: false, error: 'tabId required' } }
        }
        if (!message || hasNullByte(message)) {
          return { status: 400, body: { ok: false, error: 'message required' } }
        }
        const { sent } = await d.terminals.sendToTab(tabId, message)
        return { status: 200, body: { ok: true, sent } }
      }

      case '/tabList': {
        const tabs = await d.terminals.listTabs()
        return { status: 200, body: { ok: true, tabs } }
      }

      case '/setReply': {
        const requestId = asString(body.requestId)
        const message = asString(body.message)
        if (!REQUEST_ID_RE.test(requestId)) {
          return { status: 400, body: { ok: false, error: 'requestId required (alphanumeric + dash, 4-80)' } }
        }
        if (typeof body.message !== 'string' || hasNullByte(message)) {
          return { status: 400, body: { ok: false, error: 'message must be a string' } }
        }
        d.conductor.setReply(requestId, message.slice(0, 4000))
        return { status: 200, body: { ok: true } }
      }

      case '/trackWork': {
        const workId = asString(body.workId)
        const tabId = asString(body.tabId)
        const requestId = asString(body.requestId)
        const description = asString(body.description)
        if (!workId.trim() || !tabId.trim() || !requestId.trim() || !description.trim()) {
          return {
            status: 400,
            body: { ok: false, error: 'workId, tabId, requestId, description all required' }
          }
        }
        if ([workId, tabId, requestId, description].some(hasNullByte)) {
          return { status: 400, body: { ok: false, error: 'null byte in argument' } }
        }
        d.workRegistry.track({ workId, tabId, requestId, description })
        return { status: 200, body: { ok: true, workId } }
      }

      case '/getStatus': {
        const target = asString(body.target).trim() || undefined
        const items = d.workRegistry.status(target)
        return { status: 200, body: { ok: true, snapshot: formatWorkSnapshot(items), count: items.length } }
      }

      case '/markDone': {
        const workId = asString(body.workId)
        const summary = asString(body.summary)
        if (!workId.trim()) {
          return { status: 400, body: { ok: false, error: 'workId required' } }
        }
        const item = d.workRegistry.markDone(workId, summary, toRegistryStatus(asString(body.status)))
        if (!item) {
          return { status: 404, body: { ok: false, error: `no work item "${workId}"` } }
        }
        if (d.imessage.isAvailable()) {
          const outcome = item.status === 'done' ? 'finished' : 'failed'
          await d.imessage.send(`${item.description} ${outcome}: ${item.summary || 'No summary'}`)
        }
        return { status: 200, body: { ok: true, item } }
      }

      case '/spawn': {
        const projectPath = asString(body.projectPath)
        const agentId = asString(body.agentId)
        const initialPrompt = asString(body.initialPrompt)
        if (!projectPath.trim() || !agentId.trim()) {
          return { status: 400, body: { ok: false, error: 'projectPath and agentId required' } }
        }
        if ([projectPath, agentId, initialPrompt].some(hasNullByte)) {
          return { status: 400, body: { ok: false, error: 'null byte in argument' } }
        }
        // v1 gated the spawn behind an iMessage confirm to Carson. Preserve that
        // and FAIL CLOSED: with no confirmation channel there is no approval, so
        // refuse rather than spawn an agent unconfirmed.
        if (!d.imessage.isAvailable()) {
          return {
            status: 200,
            body: { ok: false, error: 'spawn declined (no confirmation channel available)' }
          }
        }
        const answer = await d.imessage.ask(
          `Spawn agent "${agentId}" in ${projectPath}? Reply YES to confirm.`
        )
        if (!/^\s*(y|yes|ok|okay|sure|confirm)\b/i.test(answer)) {
          return { status: 200, body: { ok: false, error: `spawn declined (${answer || 'no reply'})` } }
        }
        const spawned = await d.terminals.spawnAgent(projectPath, agentId, initialPrompt)
        return { status: 200, body: { ok: true, ...spawned } }
      }

      case '/ask': {
        const question = asString(body.question)
        if (!question.trim()) {
          return { status: 400, body: { ok: false, error: 'question required' } }
        }
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined
        const answer = await d.imessage.ask(question, timeoutMs)
        return { status: 200, body: { ok: true, answer, timedOut: answer === '' } }
      }

      case '/getLeadTab': {
        const projectPath = asString(body.projectPath)
        if (!projectPath.trim()) {
          return { status: 400, body: { ok: false, error: 'projectPath required' } }
        }
        const leadTabId = await d.terminals.getLeadTab(projectPath)
        return { status: 200, body: { ok: true, leadTabId } }
      }

      case '/setLeadTab': {
        const projectPath = asString(body.projectPath)
        if (!projectPath.trim()) {
          return { status: 400, body: { ok: false, error: 'projectPath required' } }
        }
        // tabId null (or absent) clears the lead tab; a string sets it.
        const tabId = typeof body.tabId === 'string' ? body.tabId : null
        if (tabId !== null && (hasNullByte(tabId) || !tabId.trim())) {
          return { status: 400, body: { ok: false, error: 'tabId malformed' } }
        }
        await d.terminals.setLeadTab(projectPath, tabId)
        return { status: 200, body: { ok: true, leadTabId: tabId } }
      }

      case '/asana/fetch': {
        const queue = asString(body.queue)
        const { tasks, summary } = await d.asana.fetch(queue)
        return { status: 200, body: { ok: true, tasks, summary } }
      }

      default:
        return { status: 404, body: { ok: false, error: 'unknown route' } }
    }
  } catch (err) {
    return { status: 500, body: { ok: false, error: (err as Error).message } }
  }
}

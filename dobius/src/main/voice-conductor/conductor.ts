// Voice Conductor engine (v2 port of electron/voice-conductor.js).
//
// A long-running background Opus Claude session with no window and no terminal
// tab. In v1 this lived in a detached PTY; in v2 it runs on the SDK
// agent-runner (the truly windowless path). Each voice transcript resumes the
// SAME Claude session so context carries across turns — the v2 analog of
// writing to the v1 conductor PTY's stdin.

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgent, listAgents } from '../agents/agents-store'
import { startAgentRun, stopAgentRun } from '../agents/agent-runner'
import { getDefaultPrepareClaudeLaunch } from '../agents/default-claude-launch'
import type { VoiceConductor, VoiceConductorStatus } from './types'
import { CONDUCTOR_SYSTEM_PROMPT } from './conductor-system-prompt'

// The store assigns each agent a random UUID, so the conductor agent is
// identified by this stable name (looked up via listAgents), not a fixed id.
const CONDUCTOR_AGENT_NAME = 'Voice Conductor'
const CONDUCTOR_DIR_NAME = 'dobius-voice-conductor'
const CONDUCTOR_CWD = `~/${CONDUCTOR_DIR_NAME}`
// Opus-class reasoning is required to disambiguate fuzzy transcripts
// ("be to be portal" => "B2B Portal").
const CONDUCTOR_MODEL = 'opus'
// Mirrors v1's 3s respawn backoff after an abnormal PTY exit.
const RESPAWN_DELAY_MS = 3000
const CONDUCTOR_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch'
]

// Establishes the background session on start so later transcripts have a
// session to resume; the conductor should not act until a transcript arrives.
const PRIMING_PROMPT =
  'Voice Conductor online. You are now running as a background session with no terminal window. Acknowledge readiness in one short line and stand by. Do not take any action until a tagged voice transcript arrives.'

export type ReplyEntry = { message: string; ts: number }

/**
 * Pure in-memory reply store. `now` is injectable so the sinceTs semantics can
 * be tested with a fake clock; the real conductor uses Date.now().
 */
export function createReplyStore(now: () => number = () => Date.now()): {
  set(requestId: string, message: string): void
  get(requestId: string, sinceTs?: number): ReplyEntry | null
} {
  const replies = new Map<string, ReplyEntry>()
  const MAX_REPLIES = 500
  return {
    set(requestId, message) {
      replies.set(requestId, { message, ts: now() })
      // Bound memory: evict the oldest entry once over the cap (Map keeps
      // insertion order). Replies are short-lived (one poll cycle), so this
      // never touches an entry a poller still needs.
      if (replies.size > MAX_REPLIES) {
        const oldest = replies.keys().next().value
        if (oldest !== undefined) {
          replies.delete(oldest)
        }
      }
    },
    get(requestId, sinceTs) {
      const entry = replies.get(requestId)
      if (!entry) {
        return null
      }
      // Only surface a reply strictly newer than what the caller last saw.
      if (sinceTs !== undefined && entry.ts <= sinceTs) {
        return null
      }
      return { message: entry.message, ts: entry.ts }
    }
  }
}

function conductorDir(): string {
  return join(homedir(), CONDUCTOR_DIR_NAME)
}

function ensureConductorDir(): void {
  // createAgent's assertValidCwd rejects a non-existent cwd, so the dir must
  // exist before the agent is created.
  const dir = conductorDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function ensureAgentId(): string {
  const existing = listAgents().find((agent) => agent.name === CONDUCTOR_AGENT_NAME)
  if (existing) {
    return existing.id
  }
  ensureConductorDir()
  const agents = createAgent({
    name: CONDUCTOR_AGENT_NAME,
    description: 'Background voice-transcript router (SDK agent-runner, no window or tab).',
    model: CONDUCTOR_MODEL,
    cwd: CONDUCTOR_CWD,
    bypassPermissions: true,
    systemPrompt: CONDUCTOR_SYSTEM_PROMPT,
    allowedTools: CONDUCTOR_ALLOWED_TOOLS
  })
  const created = agents.find((agent) => agent.name === CONDUCTOR_AGENT_NAME)
  if (!created) {
    throw new Error('Failed to create the Voice Conductor agent')
  }
  return created.id
}

export function createVoiceConductor(): VoiceConductor {
  const replyStore = createReplyStore()

  let enabled = false
  let running = false
  let currentRunId: string | null = null
  let sessionId: string | null = null
  let lastError: string | null = null
  let agentId: string | null = null
  let respawnTimer: ReturnType<typeof setTimeout> | null = null
  // Serializes transcript turns so they resume the session one at a time.
  let transcriptChain: Promise<void> = Promise.resolve()

  function scheduleRespawn(): void {
    if (!enabled || respawnTimer) {
      return
    }
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      if (enabled && !running) {
        // Re-establish the background session; lastError is already recorded on failure.
        void kick(PRIMING_PROMPT, { resume: true }).catch(() => {})
      }
    }, RESPAWN_DELAY_MS)
  }

  async function kick(prompt: string, opts: { resume: boolean }): Promise<void> {
    const prepare = getDefaultPrepareClaudeLaunch()
    if (!prepare) {
      throw new Error(
        'Voice Conductor requires the Dobius+ app to be running (no Claude launch preparer registered)'
      )
    }
    if (!agentId) {
      agentId = ensureAgentId()
    }
    running = true
    try {
      const runId = await startAgentRun({
        agentId,
        prompt,
        prepareClaudeLaunch: prepare,
        options: {
          source: 'channel',
          // agent-runner resolves the real session id from the agent's stored
          // lastSessionId; this flag only means "don't force a fresh session".
          resume: opts.resume,
          onResult: (message) => {
            sessionId = message.session_id
            running = false
            currentRunId = null
            lastError = message.subtype === 'success' ? null : message.errors.join('\n')
          },
          onRunEnded: (status, summary) => {
            running = false
            currentRunId = null
            // Only an abnormal end (not a user stop) triggers the v1-style respawn.
            if (status === 'error') {
              lastError = summary
              scheduleRespawn()
            }
          }
        }
      })
      currentRunId = runId
      lastError = null
    } catch (error) {
      running = false
      currentRunId = null
      lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  return {
    async start() {
      // Idempotent: already on with a live/primed run.
      if (enabled && (running || currentRunId)) {
        return
      }
      enabled = true
      ensureConductorDir()
      agentId = ensureAgentId()
      try {
        await kick(PRIMING_PROMPT, { resume: true })
      } catch (error) {
        enabled = false
        throw error
      }
    },

    async stop() {
      enabled = false
      if (respawnTimer) {
        clearTimeout(respawnTimer)
        respawnTimer = null
      }
      const runId = currentRunId
      currentRunId = null
      running = false
      if (runId) {
        await stopAgentRun(runId)
      }
    },

    isRunning() {
      return enabled
    },

    getStatus(): VoiceConductorStatus {
      return { enabled, running, runId: currentRunId, sessionId, lastError }
    },

    async postTranscript({ transcript, requestId }) {
      if (!enabled) {
        throw new Error('Voice Conductor is disabled')
      }
      // The v2 analog of writing to the v1 conductor PTY's stdin: a fresh run
      // that resumes the same session, tagged so the reply routes back.
      // Serialize turns — two transcripts resuming the SAME session concurrently
      // would cross or drop each other, so chain them one at a time.
      transcriptChain = transcriptChain
        .catch(() => {})
        .then(() => kick(`[${requestId}] ${transcript}`, { resume: true }))
      return transcriptChain
    },

    setReply(requestId, message) {
      replyStore.set(requestId, message)
    },

    getReply(requestId, sinceTs) {
      return replyStore.get(requestId, sinceTs)
    }
  }
}

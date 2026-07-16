// Lifecycle coordinator for the Voice Conductor. Owns the singleton engine +
// leaf modules and starts/stops them in step with the `voice.conductorEnabled`
// setting. Wired from src/main/index.ts at boot and on every settings change.

import path from 'node:path'
import { app } from 'electron'
import type { GlobalSettings } from '../../shared/types'
import type { DobiusCliDispatcher } from '../dobius-cli/dispatch-server'
import { listAgents } from '../agents/agents-store'
import { startAgentRun } from '../agents/agent-runner'
import { getDefaultPrepareClaudeLaunch } from '../agents/default-claude-launch'
import { createVoiceConductor } from './conductor'
import { createIMessageBridge } from './imessage-bridge'
import { createAsanaQueue } from './asana-queue'
import {
  startConductorCliServer,
  stopConductorCliServer,
  type ConductorCliDeps,
  type ConductorTerminalDispatch
} from './cli-server'
import { createLeadTabStore } from './lead-tab-store'
import { createConductorAgentSpawner } from './agent-spawn'
import { createPersistentWorkRegistry } from './persistent-work-registry'

// Build vs review lanes per the workspace house rules (build = Carson, review = Sam).
// Gids live here rather than being hardcoded in the leaf module (its guardrail).
const BUILD_GID = '1215600517617968'
const REVIEW_GID = '1213473231797717'

const conductor = createVoiceConductor()
let started = false
let leadTabStore: ReturnType<typeof createLeadTabStore> | null = null

function getLeadTabStore(): ReturnType<typeof createLeadTabStore> {
  leadTabStore ??= createLeadTabStore(path.join(app.getPath('userData'), 'voice-conductor-tabs.json'))
  return leadTabStore
}

/**
 * Back the CLI dispatch verbs with v2's runtime terminal API. Custom-agent
 * spawning still needs the v1 agent-spawner behavior mapped onto v2's agent
 * runner, so it fails loudly rather than silently pretending to work.
 */
function buildTerminalDispatch(
  runtime: DobiusCliDispatcher,
  imessage: ReturnType<typeof createIMessageBridge>
): ConductorTerminalDispatch {
  const tabs = getLeadTabStore()
  const agentSpawner = createConductorAgentSpawner({
    listAgents,
    getPrepareClaudeLaunch: getDefaultPrepareClaudeLaunch,
    startAgentRun,
    notify: (message) => imessage.send(message)
  })
  return {
    resolveActiveTab: () => runtime.resolveActiveTerminal(),
    sendToTab: async (tabId, text) => {
      await runtime.sendTerminal(tabId, { text, enter: true })
      return { sent: text.length }
    },
    listTabs: async () => {
      const { terminals } = await runtime.listTerminals()
      return terminals.map((t) => ({
        id: t.handle,
        title: t.title ?? '',
        projectPath: t.worktreePath ?? '',
        cwd: t.worktreePath ?? ''
      }))
    },
    spawnAgent: (projectPath, agentId, prompt) => agentSpawner.spawn(projectPath, agentId, prompt),
    getLeadTab: async (projectPath) => {
      const savedTabId = tabs.get(projectPath)
      if (!savedTabId) {
        return null
      }
      const normalizedProjectPath = path.resolve(projectPath)
      const liveTabs = await runtime.listTerminals()
      const isLiveForProject = liveTabs.terminals.some(
        (terminal) =>
          terminal.handle === savedTabId &&
          terminal.worktreePath !== undefined &&
          path.resolve(terminal.worktreePath) === normalizedProjectPath
      )
      if (!isLiveForProject) {
        tabs.set(projectPath, null)
        return null
      }
      return savedTabId
    },
    setLeadTab: async (projectPath, tabId) => {
      if (tabId !== null) {
        const normalizedProjectPath = path.resolve(projectPath)
        const liveTabs = await runtime.listTerminals()
        const isLiveForProject = liveTabs.terminals.some(
          (terminal) =>
            terminal.handle === tabId &&
            terminal.worktreePath !== undefined &&
            path.resolve(terminal.worktreePath) === normalizedProjectPath
        )
        if (!isLiveForProject) {
          throw new Error('lead tab must be a live terminal in the selected project')
        }
      }
      tabs.set(projectPath, tabId)
    }
  }
}

/**
 * Reconcile the running conductor with the current setting. Idempotent: safe to
 * call at boot and on every settings change. `imessageHandle` is the handle the
 * conductor texts for confirmations/reports (empty string disables iMessage asks).
 */
export function syncVoiceConductorFromSettings(
  settings: GlobalSettings,
  runtime: DobiusCliDispatcher,
  imessageHandle: string
): void {
  const enabled = settings.voice?.conductorEnabled ?? false
  if (enabled && !started) {
    const imessage = createIMessageBridge({ handle: imessageHandle })
    const workRegistry = createPersistentWorkRegistry(
      path.join(app.getPath('userData'), 'voice-conductor-work.json')
    )
    const deps: ConductorCliDeps = {
      conductor,
      workRegistry,
      imessage,
      asana: createAsanaQueue({ buildGid: BUILD_GID, reviewGid: REVIEW_GID }),
      terminals: buildTerminalDispatch(runtime, imessage)
    }
    started = true // reserve up front so a concurrent sync can't double-start
    startConductorCliServer(deps)
    void conductor.start().catch((err) => {
      // Fail-safe: tear down so a later toggle / settings change retries cleanly
      // instead of leaving the CLI server up with a dead conductor.
      console.error('[voice-conductor] start failed:', err)
      stopConductorCliServer()
      started = false
    })
  } else if (!enabled && started) {
    started = false
    stopConductorCliServer()
    void conductor.stop().catch((err) => {
      console.error('[voice-conductor] stop failed:', err)
    })
  }
}

/** Feed a transcript to the running conductor (mobile /voice/intent analog). */
export function postVoiceConductorTranscript(input: {
  transcript: string
  requestId: string
}): Promise<void> {
  if (!started || !conductor.isRunning()) {
    return Promise.reject(new Error('Voice Conductor is disabled'))
  }
  return conductor.postTranscript(input)
}

/** Read the conductor's reply for a request id, for the /voice/reply poller. */
export function getVoiceConductorReply(
  requestId: string,
  sinceTs?: number
): { message: string; ts: number } | null {
  return conductor.getReply(requestId, sinceTs)
}

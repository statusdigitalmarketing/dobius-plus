import { dialog, ipcMain } from 'electron'
import type {
  AgentCrewFileName,
  AgentIdentityFileName,
  AgentDecisionResolution,
  BriefingItem,
  CustomAgentInput,
  CustomAgentUpdate
} from '../../shared/agents'
import type { Store } from '../persistence'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import {
  createAgent,
  getAgent,
  listAgents,
  removeAgent,
  resetAgentSession,
  updateAgent
} from '../agents/agents-store'
import { listAgentRuns, startAgentRun, stopAgentRun } from '../agents/agent-runner'
import { setDefaultPrepareClaudeLaunch } from '../agents/default-claude-launch'
import { listAgentDecisions, resolveAgentDecision } from '../agents/agent-decision-queue'
import {
  listAgentNotifications,
  markAgentNotificationsRead
} from '../agents/agent-notification-store'
import { dismissBriefingItems, listRecentBriefingItems } from '../agents/agent-briefing-store'
import { getAgentsPaused, getPingStatus, setAgentsPaused } from '../agents/agents-config-store'
import { startAgentHeartbeats } from '../agents/agent-heartbeat-service'
import { startAsanaAutoMode } from '../agents/asana-auto-mode-service'
import { listDrafts, setDraftStatus } from '../agents/agent-draft-store'
import { approveDraftAndPost } from '../agents/agent-draft-approval'
import { setDobiusToolKnowledgeStore } from '../agents/agent-tools/dobius-tool-server'
import {
  readAgentFiles,
  readCrewFiles,
  writeAgentFile,
  writeCrewFile
} from '../agents/agent-identity-files'

type PrepareClaudeLaunch = () => Promise<ClaudeRuntimeAuthPreparation>

export function registerAgentsHandlers(
  prepareClaudeLaunch: PrepareClaudeLaunch,
  store: Store
): void {
  setDobiusToolKnowledgeStore(store)
  setDefaultPrepareClaudeLaunch(prepareClaudeLaunch)
  startAgentHeartbeats(prepareClaudeLaunch)
  startAsanaAutoMode(prepareClaudeLaunch)

  ipcMain.removeHandler('agents:list')
  ipcMain.handle('agents:list', () => listAgents())

  ipcMain.removeHandler('agents:create')
  ipcMain.handle('agents:create', (_event, input: CustomAgentInput) => createAgent(input))

  ipcMain.removeHandler('agents:update')
  ipcMain.handle('agents:update', (_event, id: string, updates: CustomAgentUpdate) =>
    updateAgent(id, updates)
  )

  ipcMain.removeHandler('agents:delete')
  ipcMain.handle('agents:delete', (_event, id: string) => removeAgent(id))

  // Why: agentId is renderer-supplied — resolve it to a known agent before any
  // filesystem access (defense in depth with the path guard in agent-identity-files).
  const requireAgentId = (agentId: string): string => {
    const agent = getAgent(agentId)
    if (!agent) {
      throw new Error('Agent not found')
    }
    return agent.id
  }

  ipcMain.removeHandler('agents:readFiles')
  ipcMain.handle('agents:readFiles', (_event, agentId: string) =>
    readAgentFiles(requireAgentId(agentId))
  )

  ipcMain.removeHandler('agents:writeFile')
  ipcMain.handle(
    'agents:writeFile',
    (_event, agentId: string, name: AgentIdentityFileName | 'brief' | 'memory', content: string) =>
      writeAgentFile(requireAgentId(agentId), name, content)
  )

  ipcMain.removeHandler('agents:readCrewFiles')
  ipcMain.handle('agents:readCrewFiles', () => readCrewFiles())

  ipcMain.removeHandler('agents:writeCrewFile')
  ipcMain.handle('agents:writeCrewFile', (_event, name: AgentCrewFileName, content: string) =>
    writeCrewFile(name, content)
  )

  ipcMain.removeHandler('agents:resetSession')
  ipcMain.handle('agents:resetSession', (_event, id: string) => resetAgentSession(id))

  ipcMain.removeHandler('agents:run')
  ipcMain.handle('agents:run', (_event, args: { agentId: string; prompt: string }) =>
    startAgentRun({ ...args, prepareClaudeLaunch })
  )

  ipcMain.removeHandler('agents:stop')
  ipcMain.handle('agents:stop', (_event, runId: string) => stopAgentRun(runId))

  ipcMain.removeHandler('agents:listRuns')
  ipcMain.handle('agents:listRuns', () => listAgentRuns())

  ipcMain.removeHandler('agents:listDecisions')
  ipcMain.handle('agents:listDecisions', () => listAgentDecisions())

  ipcMain.removeHandler('agents:resolveDecision')
  ipcMain.handle('agents:resolveDecision', (_event, resolution: AgentDecisionResolution) =>
    resolveAgentDecision(resolution)
  )

  ipcMain.removeHandler('agents:listNotifications')
  ipcMain.handle('agents:listNotifications', () => listAgentNotifications())

  ipcMain.removeHandler('agents:markNotificationsRead')
  ipcMain.handle('agents:markNotificationsRead', () => markAgentNotificationsRead())

  ipcMain.removeHandler('agents:listBriefing')
  ipcMain.handle('agents:listBriefing', (): BriefingItem[] => listRecentBriefingItems())

  ipcMain.removeHandler('agents:dismissBriefing')
  ipcMain.handle('agents:dismissBriefing', () => dismissBriefingItems())

  ipcMain.removeHandler('agents:listDrafts')
  ipcMain.handle('agents:listDrafts', () => listDrafts())

  ipcMain.removeHandler('agents:discardDraft')
  ipcMain.handle('agents:discardDraft', (_event, id: string) => {
    const draft = setDraftStatus(id, 'discarded')
    if (!draft) {
      throw new Error('Draft not found')
    }
    return draft
  })

  // Why: approving a draft is the only W2 path that writes an Asana comment, and it is IPC-only.
  ipcMain.removeHandler('agents:approveDraft')
  ipcMain.handle('agents:approveDraft', (_event, id: string) => approveDraftAndPost(id))

  ipcMain.removeHandler('agents:getPaused')
  ipcMain.handle('agents:getPaused', () => getAgentsPaused())

  ipcMain.removeHandler('agents:setPaused')
  ipcMain.handle('agents:setPaused', (_event, paused: boolean) => setAgentsPaused(paused))

  ipcMain.removeHandler('agents:getPingStatus')
  ipcMain.handle('agents:getPingStatus', () => getPingStatus())

  ipcMain.removeHandler('agents:pickDirectory')
  ipcMain.handle(
    'agents:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        // Why: agent cwd selection needs an existing folder grant; directory
        // creation can leave partial paths behind on macOS.
        properties: ['openDirectory']
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  )
}

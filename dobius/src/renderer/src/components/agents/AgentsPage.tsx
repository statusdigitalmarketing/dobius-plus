import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  AgentIdentityFileName,
  AgentReadableFiles,
  AgentRun,
  AgentRunEvent,
  BriefingItem,
  CustomAgent
} from '../../../../shared/agents'
import { AgentList } from './AgentList'
import { AgentMissionControlPanel } from './AgentMissionControlPanel'
import { AgentPageDialogs } from './AgentPageDialogs'
import { AgentsPageHeader } from './AgentsPageHeader'
import { countSilentHeartbeatRunsToday } from './agent-briefing-count'
import { DEFAULT_AGENT_FILES } from './agent-default-files'
import { useCrewFiles } from './use-crew-files'
import { useAgentDecisions } from './use-agent-decisions'
import { useAgentDetailActions } from './use-agent-detail-actions'
import { useAgentTerminalSelection } from './use-agent-terminal-selection'
import { useAgentPageInitialLoad } from './use-agent-page-initial-load'
import { useAgentDrafts } from './use-agent-drafts'
import {
  agentToDraft,
  TRANSCRIPT_LIMIT,
  type AgentDraft,
  type AgentPageMode
} from './agent-page-state'
import { useTerminalAgentRows } from './use-terminal-agent-rows'

export default function AgentsPage(): React.JSX.Element {
  const [agents, setAgents] = useState<CustomAgent[]>([])
  const [runs, setRuns] = useState<AgentRun[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDraft>(() => agentToDraft(null))
  const [mode, setMode] = useState<AgentPageMode>('run')
  const [editOpen, setEditOpen] = useState(false)
  const [agentFiles, setAgentFiles] = useState<AgentReadableFiles>(DEFAULT_AGENT_FILES)
  const [activeIdentityFile, setActiveIdentityFile] = useState<AgentIdentityFileName>('soul')
  const [prompt, setPrompt] = useState('')
  const [transcript, setTranscript] = useState<AgentRunEvent[]>([])
  const [saving, setSaving] = useState(false)
  const [briefingItems, setBriefingItems] = useState<BriefingItem[]>([])
  const [paused, setPaused] = useState(false)
  const [pingStatus, setPingStatus] = useState<{ used: number; max: number; date: string } | null>(
    null
  )
  const { drafts, hasAsanaToken, loadDrafts, approveDraft, discardDraft } = useAgentDrafts()
  const {
    crewFilesOpen,
    setCrewFilesOpen,
    crewFiles,
    setCrewFiles,
    activeCrewFile,
    setActiveCrewFile,
    savingCrewFiles,
    openCrewFiles,
    saveCrewFiles
  } = useCrewFiles()
  const [starting, setStarting] = useState(false)
  const selectedAgentIdRef = useRef<string | null>(null)
  const terminalRows = useTerminalAgentRows()
  const { selectedTerminal, selectAgent, selectTerminal, openTerminal } = useAgentTerminalSelection(
    {
      terminalRows,
      selectedTerminalId,
      setSelectedAgentId,
      setSelectedTerminalId,
      setMode
    }
  )

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  )
  const selectedRuns = useMemo(
    () =>
      runs
        .filter((run) => run.agentId === selectedAgentId)
        .sort((a, b) => b.startedAt - a.startedAt),
    [runs, selectedAgentId]
  )
  const runningRun = selectedRuns.find((run) => run.status === 'running') ?? null
  const {
    decisions,
    selectedDecisions,
    openDecisionId,
    waitingOnDecision,
    setOpenDecisionId,
    loadDecisions
  } = useAgentDecisions({
    selectedAgentId,
    runningRun,
    setSelectedAgentId,
    setMode
  })
  const { savingMemory, resettingSession, saveMemory, resetSession, saveTagline } =
    useAgentDetailActions({
      selectedAgentId,
      selectedAgent,
      memoryContent: agentFiles.memory,
      setAgents
    })

  const loadAgents = useCallback(async (): Promise<void> => {
    const nextAgents = await window.api.agents.list()
    setAgents(nextAgents)
    setSelectedAgentId((current) => current ?? nextAgents[0]?.id ?? null)
  }, [])

  const loadRuns = useCallback(async (): Promise<void> => {
    setRuns(await window.api.agents.listRuns())
  }, [])

  const loadBriefing = useCallback(async (): Promise<void> => {
    const [items, status] = await Promise.all([
      window.api.agents.listBriefing(),
      window.api.agents.getPingStatus()
    ])
    setBriefingItems(items)
    setPingStatus(status)
  }, [])

  const loadPaused = useCallback(async (): Promise<void> => {
    setPaused(await window.api.agents.getPaused())
  }, [])

  useAgentPageInitialLoad({ loadAgents, loadRuns, loadBriefing, loadPaused })

  useEffect(() => {
    selectedAgentIdRef.current = selectedAgentId
    setDraft(agentToDraft(selectedAgent))
    setTranscript([])
  }, [selectedAgent, selectedAgentId])

  useEffect(() => {
    if (!selectedAgentId) {
      setAgentFiles(DEFAULT_AGENT_FILES)
      return
    }
    void window.api.agents
      .readFiles(selectedAgentId)
      .then(setAgentFiles)
      .catch((error) => {
        console.error('Failed to load agent files:', error)
        toast.error('Could not load agent files')
      })
  }, [selectedAgentId])

  useEffect(() => {
    const unsubscribeRunEvent = window.api.agents.onRunEvent((event) => {
      if (event.agentId !== selectedAgentIdRef.current) {
        return
      }
      setTranscript((events) => [...events, event].slice(-TRANSCRIPT_LIMIT))
    })
    const unsubscribeRunsChanged = window.api.agents.onRunsChanged(() => {
      void loadRuns()
    })
    const unsubscribeBriefingChanged = window.api.agents.onBriefingChanged(() => {
      void loadBriefing()
    })
    const unsubscribeDraftsChanged = window.api.agents.onDraftsChanged(() => {
      void loadDrafts()
    })
    return () => {
      unsubscribeRunEvent()
      unsubscribeRunsChanged()
      unsubscribeBriefingChanged()
      unsubscribeDraftsChanged()
    }
  }, [loadBriefing, loadDrafts, loadRuns])

  const createNewAgent = (): void => {
    setSelectedTerminalId(null)
    setSelectedAgentId(null)
    setDraft(agentToDraft(null))
    setAgentFiles(DEFAULT_AGENT_FILES)
    setActiveIdentityFile('soul')
    setEditOpen(true)
    setMode('run')
    setTranscript([])
  }

  const openEditAgent = (): void => {
    if (!selectedAgent) {
      createNewAgent()
      return
    }
    setDraft(agentToDraft(selectedAgent))
    setEditOpen(true)
  }

  const saveAgent = async (): Promise<void> => {
    setSaving(true)
    try {
      const nextAgents = draft.id
        ? await window.api.agents.update(draft.id, draft)
        : await window.api.agents.create(draft)
      setAgents(nextAgents)
      const saved =
        (draft.id ? nextAgents.find((agent) => agent.id === draft.id) : nextAgents.at(-1)) ?? null
      if (saved) {
        await Promise.all(
          (['soul', 'role', 'playbook', 'rules', 'brief', 'memory'] as const).map((name) =>
            window.api.agents.writeFile(saved.id, name, agentFiles[name])
          )
        )
      }
      setSelectedAgentId(saved?.id ?? null)
      setEditOpen(false)
      toast.success('Agent saved')
    } catch (error) {
      console.error('Failed to save agent:', error)
      toast.error(error instanceof Error ? error.message : 'Could not save agent')
    } finally {
      setSaving(false)
    }
  }

  const deleteAgent = async (): Promise<void> => {
    if (!draft.id) {
      createNewAgent()
      return
    }
    try {
      const nextAgents = await window.api.agents.delete(draft.id)
      setAgents(nextAgents)
      setSelectedAgentId(nextAgents[0]?.id ?? null)
      setEditOpen(false)
      toast.success('Agent deleted; memory file kept on disk')
    } catch (error) {
      console.error('Failed to delete agent:', error)
      toast.error(error instanceof Error ? error.message : 'Could not delete agent')
    }
  }

  const runAgent = async (): Promise<void> => {
    if (!selectedAgentId) {
      toast.error('Save the agent before running it')
      return
    }
    const text = prompt.trim()
    if (!text) {
      toast.error('Prompt is required')
      return
    }
    setStarting(true)
    setTranscript([])
    try {
      await window.api.agents.run({ agentId: selectedAgentId, prompt: text })
      setPrompt('')
      await loadRuns()
    } catch (error) {
      console.error('Failed to run agent:', error)
      toast.error(error instanceof Error ? error.message : 'Could not run agent')
    } finally {
      setStarting(false)
    }
  }

  const stopRun = async (): Promise<void> => {
    if (!runningRun) {
      return
    }
    try {
      await window.api.agents.stop(runningRun.id)
      await loadRuns()
    } catch (error) {
      console.error('Failed to stop agent run:', error)
      toast.error(error instanceof Error ? error.message : 'Could not stop run')
    }
  }

  const togglePaused = async (): Promise<void> => {
    try {
      setPaused(await window.api.agents.setPaused(!paused))
    } catch (error) {
      console.error('Failed to change crew pause state:', error)
      toast.error('Could not change crew pause state')
    }
  }

  const dismissBriefing = async (): Promise<void> => {
    try {
      await window.api.agents.dismissBriefing()
      await loadBriefing()
    } catch (error) {
      console.error('Failed to dismiss briefing:', error)
      toast.error('Could not dismiss briefing')
    }
  }

  const silentRunsToday = useMemo(
    () => countSilentHeartbeatRunsToday(briefingItems, runs),
    [briefingItems, runs]
  )

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <AgentsPageHeader
        agentCount={agents.length}
        paused={paused}
        pingStatus={pingStatus}
        onTogglePaused={() => void togglePaused()}
      />

      <section className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <AgentList
          agents={agents}
          runs={runs}
          decisions={decisions}
          terminalRows={terminalRows}
          selectedAgentId={selectedAgentId}
          selectedTerminalId={selectedTerminalId}
          onCreate={createNewAgent}
          onOpenCrewFiles={() => void openCrewFiles()}
          onSelect={selectAgent}
          onSelectTerminal={selectTerminal}
        />
        <AgentMissionControlPanel
          agents={agents}
          runs={runs}
          decisions={decisions}
          selectedDecisions={selectedDecisions}
          terminalRows={terminalRows}
          selectedAgentId={selectedAgentId}
          selectedTerminalId={selectedTerminalId}
          selectedTerminal={selectedTerminal}
          selectedAgent={selectedAgent}
          draft={draft}
          mode={mode}
          agentFiles={agentFiles}
          briefingItems={briefingItems}
          drafts={drafts}
          hasAsanaToken={hasAsanaToken}
          silentRunsToday={silentRunsToday}
          waitingOnDecision={waitingOnDecision}
          runningRun={runningRun}
          selectedRuns={selectedRuns}
          prompt={prompt}
          transcript={transcript}
          savingMemory={savingMemory}
          resettingSession={resettingSession}
          starting={starting}
          onSelectAgent={selectAgent}
          onSelectTerminal={selectTerminal}
          onDismissBriefing={() => void dismissBriefing()}
          onApproveDraft={approveDraft}
          onDiscardDraft={(id) => void discardDraft(id)}
          onOpenDecision={setOpenDecisionId}
          onOpenTerminal={openTerminal}
          onDraftChange={setDraft}
          onEditAgent={openEditAgent}
          onModeChange={setMode}
          onSaveTagline={(tagline) => void saveTagline(tagline)}
          onMemoryChange={(memory) => setAgentFiles({ ...agentFiles, memory })}
          onResetSession={() => void resetSession()}
          onSaveMemory={() => void saveMemory()}
          onPromptChange={setPrompt}
          onRun={() => void runAgent()}
          onStop={() => void stopRun()}
        />
      </section>
      <AgentPageDialogs
        editOpen={editOpen}
        draft={draft}
        agentFiles={agentFiles}
        activeIdentityFile={activeIdentityFile}
        saving={saving}
        crewFilesOpen={crewFilesOpen}
        crewFiles={crewFiles}
        activeCrewFile={activeCrewFile}
        savingCrewFiles={savingCrewFiles}
        agents={agents}
        decisions={decisions}
        openDecisionId={openDecisionId}
        onActiveIdentityFileChange={setActiveIdentityFile}
        onDraftChange={setDraft}
        onAgentFilesChange={setAgentFiles}
        onDeleteAgent={() => void deleteAgent()}
        onEditOpenChange={(open) => {
          setEditOpen(open)
          // Why: cancelled edits must not survive into the next save.
          if (!open && selectedAgentId) {
            void window.api.agents
              .readFiles(selectedAgentId)
              .then(setAgentFiles)
              .catch((error) => {
                console.error('Failed to reload agent files after closing editor:', error)
                setAgentFiles(DEFAULT_AGENT_FILES)
              })
          }
        }}
        onSaveAgent={() => void saveAgent()}
        onCrewFilesChange={setCrewFiles}
        onActiveCrewFileChange={setActiveCrewFile}
        onCrewFilesOpenChange={setCrewFilesOpen}
        onSaveCrewFiles={() => void saveCrewFiles()}
        onOpenDecisionChange={setOpenDecisionId}
        onDecisionResolved={() => void loadDecisions()}
      />
    </main>
  )
}

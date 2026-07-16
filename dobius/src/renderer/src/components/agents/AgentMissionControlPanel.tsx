import type {
  AgentReadableFiles,
  AgentRun,
  AgentRunEvent,
  AgentDraftComment,
  BriefingItem,
  CustomAgent,
  PendingAgentDecision
} from '../../../../shared/agents'
import { AgentBriefingCard } from './AgentBriefingCard'
import { AgentDecisionStrip } from './AgentDecisionStrip'
import { AgentDetailHeader } from './AgentDetailHeader'
import { AgentDraftsPanel } from './AgentDraftsPanel'
import { AgentLivePulse } from './AgentLivePulse'
import { AgentMemoryView } from './AgentMemoryView'
import { AgentRunView } from './AgentRunView'
import { AgentTerminalDetail } from './AgentTerminalDetail'
import type { AgentDraft, AgentPageMode } from './agent-page-state'
import type { TerminalAgentRosterRow } from './use-terminal-agent-rows'

export function AgentMissionControlPanel({
  agents,
  runs,
  decisions,
  selectedDecisions,
  terminalRows,
  selectedAgentId,
  selectedTerminalId,
  selectedTerminal,
  selectedAgent,
  draft,
  mode,
  agentFiles,
  briefingItems,
  drafts,
  hasAsanaToken,
  silentRunsToday,
  waitingOnDecision,
  runningRun,
  selectedRuns,
  prompt,
  transcript,
  savingMemory,
  resettingSession,
  starting,
  onSelectAgent,
  onSelectTerminal,
  onDismissBriefing,
  onApproveDraft,
  onDiscardDraft,
  onOpenDecision,
  onOpenTerminal,
  onDraftChange,
  onEditAgent,
  onModeChange,
  onSaveTagline,
  onMemoryChange,
  onResetSession,
  onSaveMemory,
  onPromptChange,
  onRun,
  onStop
}: {
  agents: CustomAgent[]
  runs: AgentRun[]
  decisions: PendingAgentDecision[]
  selectedDecisions: PendingAgentDecision[]
  terminalRows: TerminalAgentRosterRow[]
  selectedAgentId: string | null
  selectedTerminalId: string | null
  selectedTerminal: TerminalAgentRosterRow | null
  selectedAgent: CustomAgent | null
  draft: AgentDraft
  mode: AgentPageMode
  agentFiles: AgentReadableFiles
  briefingItems: BriefingItem[]
  drafts: AgentDraftComment[]
  hasAsanaToken: boolean | null
  silentRunsToday: number
  waitingOnDecision: boolean
  runningRun: AgentRun | null
  selectedRuns: AgentRun[]
  prompt: string
  transcript: AgentRunEvent[]
  savingMemory: boolean
  resettingSession: boolean
  starting: boolean
  onSelectAgent: (id: string) => void
  onSelectTerminal: (id: string) => void
  onDismissBriefing: () => void
  onApproveDraft: (id: string) => Promise<void>
  onDiscardDraft: (id: string) => void
  onOpenDecision: (id: string) => void
  onOpenTerminal: (row: TerminalAgentRosterRow) => void
  onDraftChange: (draft: AgentDraft) => void
  onEditAgent: () => void
  onModeChange: (mode: AgentPageMode) => void
  onSaveTagline: (tagline: string) => void
  onMemoryChange: (content: string) => void
  onResetSession: () => void
  onSaveMemory: () => void
  onPromptChange: (prompt: string) => void
  onRun: () => void
  onStop: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col">
      <AgentLivePulse
        agents={agents}
        runs={runs}
        decisions={decisions}
        terminals={terminalRows}
        selectedAgentId={selectedAgentId}
        selectedTerminalId={selectedTerminalId}
        onSelectAgent={onSelectAgent}
        onSelectTerminal={onSelectTerminal}
      />
      <AgentBriefingCard
        agents={agents}
        items={briefingItems}
        silentRunsToday={silentRunsToday}
        onDismiss={onDismissBriefing}
      />
      <AgentDraftsPanel
        agents={agents}
        drafts={drafts}
        hasAsanaToken={hasAsanaToken}
        onApprove={onApproveDraft}
        onDiscard={onDiscardDraft}
      />
      <AgentDecisionStrip
        agents={agents}
        decisions={selectedDecisions}
        onOpenDecision={onOpenDecision}
      />
      {selectedTerminal ? (
        <AgentTerminalDetail row={selectedTerminal} onOpenTerminal={onOpenTerminal} />
      ) : (
        <>
          <AgentDetailHeader
            selectedAgent={selectedAgent}
            draft={draft}
            mode={mode}
            onDraftChange={onDraftChange}
            onEdit={onEditAgent}
            onModeChange={onModeChange}
            onSaveTagline={onSaveTagline}
          />
          {mode === 'memory' && selectedAgent ? (
            <AgentMemoryView
              agent={selectedAgent}
              memory={agentFiles.memory}
              saving={savingMemory}
              resetting={resettingSession}
              onMemoryChange={onMemoryChange}
              onResetSession={onResetSession}
              onSave={onSaveMemory}
            />
          ) : (
            <AgentRunView
              prompt={prompt}
              transcript={transcript}
              runs={selectedRuns}
              runningRun={runningRun}
              waitingOnDecision={waitingOnDecision}
              starting={starting}
              onPromptChange={onPromptChange}
              onRun={onRun}
              onStop={onStop}
            />
          )}
        </>
      )}
    </div>
  )
}

import type {
  AgentCrewFileName,
  AgentCrewFiles,
  AgentIdentityFileName,
  AgentReadableFiles,
  CustomAgent,
  PendingAgentDecision
} from '../../../../shared/agents'
import { AgentDecisionTicketDialog } from './AgentDecisionTicketDialog'
import { AgentEditForm } from './AgentEditForm'
import { CrewFilesDialog } from './CrewFilesDialog'
import type { AgentDraft } from './agent-page-state'

export function AgentPageDialogs({
  editOpen,
  draft,
  agentFiles,
  activeIdentityFile,
  saving,
  crewFilesOpen,
  crewFiles,
  activeCrewFile,
  savingCrewFiles,
  agents,
  decisions,
  openDecisionId,
  onActiveIdentityFileChange,
  onDraftChange,
  onAgentFilesChange,
  onDeleteAgent,
  onEditOpenChange,
  onSaveAgent,
  onCrewFilesChange,
  onActiveCrewFileChange,
  onCrewFilesOpenChange,
  onSaveCrewFiles,
  onOpenDecisionChange,
  onDecisionResolved
}: {
  editOpen: boolean
  draft: AgentDraft
  agentFiles: AgentReadableFiles
  activeIdentityFile: AgentIdentityFileName
  saving: boolean
  crewFilesOpen: boolean
  crewFiles: AgentCrewFiles
  activeCrewFile: AgentCrewFileName
  savingCrewFiles: boolean
  agents: CustomAgent[]
  decisions: PendingAgentDecision[]
  openDecisionId: string | null
  onActiveIdentityFileChange: (name: AgentIdentityFileName) => void
  onDraftChange: (draft: AgentDraft) => void
  onAgentFilesChange: (files: AgentReadableFiles) => void
  onDeleteAgent: () => void
  onEditOpenChange: (open: boolean) => void
  onSaveAgent: () => void
  onCrewFilesChange: (files: AgentCrewFiles) => void
  onActiveCrewFileChange: (name: AgentCrewFileName) => void
  onCrewFilesOpenChange: (open: boolean) => void
  onSaveCrewFiles: () => void
  onOpenDecisionChange: (id: string | null) => void
  onDecisionResolved: () => void
}): React.JSX.Element {
  return (
    <>
      <AgentEditForm
        open={editOpen}
        draft={draft}
        files={agentFiles}
        activeFile={activeIdentityFile}
        saving={saving}
        onActiveFileChange={onActiveIdentityFileChange}
        onDraftChange={onDraftChange}
        onFilesChange={onAgentFilesChange}
        onDelete={onDeleteAgent}
        onOpenChange={onEditOpenChange}
        onSave={onSaveAgent}
      />
      <CrewFilesDialog
        open={crewFilesOpen}
        files={crewFiles}
        activeFile={activeCrewFile}
        saving={savingCrewFiles}
        onActiveFileChange={onActiveCrewFileChange}
        onFilesChange={onCrewFilesChange}
        onOpenChange={onCrewFilesOpenChange}
        onSave={onSaveCrewFiles}
      />
      <AgentDecisionTicketDialog
        agents={agents}
        decisions={decisions}
        openDecisionId={openDecisionId}
        onOpenDecisionChange={onOpenDecisionChange}
        onResolved={onDecisionResolved}
      />
    </>
  )
}

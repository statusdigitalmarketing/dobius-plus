import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { AgentRun, PendingAgentDecision } from '../../../../shared/agents'
import type { AgentPageMode } from './agent-page-state'

export function useAgentDecisions({
  selectedAgentId,
  runningRun,
  setSelectedAgentId,
  setMode
}: {
  selectedAgentId: string | null
  runningRun: AgentRun | null
  setSelectedAgentId: (id: string) => void
  setMode: (mode: AgentPageMode) => void
}): {
  decisions: PendingAgentDecision[]
  selectedDecisions: PendingAgentDecision[]
  openDecisionId: string | null
  waitingOnDecision: boolean
  setOpenDecisionId: (id: string | null) => void
  loadDecisions: () => Promise<void>
} {
  const [decisions, setDecisions] = useState<PendingAgentDecision[]>([])
  const [openDecisionId, setOpenDecisionId] = useState<string | null>(null)

  const loadDecisions = useCallback(async (): Promise<void> => {
    setDecisions(await window.api.agents.listDecisions())
  }, [])

  useEffect(() => {
    void loadDecisions().catch((error) => {
      console.error('Failed to load agent decisions:', error)
      toast.error('Could not load agent decisions')
    })
  }, [loadDecisions])

  useEffect(() => {
    const unsubscribeDecisionsChanged = window.api.agents.onDecisionsChanged(() => {
      void loadDecisions()
    })
    const openDecision = (event: Event): void => {
      const detail = (event as CustomEvent<{ decisionId?: string; agentId?: string }>).detail
      if (detail?.agentId) {
        setSelectedAgentId(detail.agentId)
        setMode('run')
      }
      if (detail?.decisionId) {
        setOpenDecisionId(detail.decisionId)
      }
    }
    window.addEventListener('agents:openDecision', openDecision)
    return () => {
      unsubscribeDecisionsChanged()
      window.removeEventListener('agents:openDecision', openDecision)
    }
  }, [loadDecisions, setMode, setSelectedAgentId])

  const selectedDecisions = useMemo(
    () => decisions.filter((decision) => decision.agentId === selectedAgentId),
    [decisions, selectedAgentId]
  )
  const waitingOnDecision = Boolean(
    runningRun && decisions.some((decision) => decision.runId === runningRun.id)
  )

  return {
    decisions,
    selectedDecisions,
    openDecisionId,
    waitingOnDecision,
    setOpenDecisionId,
    loadDecisions
  }
}

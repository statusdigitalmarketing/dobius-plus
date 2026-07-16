import { useState } from 'react'
import { toast } from 'sonner'
import type { CustomAgent } from '../../../../shared/agents'

// Memory save, session reset, and tagline save for the selected agent.
export function useAgentDetailActions(args: {
  selectedAgentId: string | null
  selectedAgent: CustomAgent | null
  memoryContent: string
  setAgents: (agents: CustomAgent[]) => void
}): {
  savingMemory: boolean
  resettingSession: boolean
  saveMemory: () => Promise<void>
  resetSession: () => Promise<void>
  saveTagline: (value: string) => Promise<void>
} {
  const { selectedAgentId, selectedAgent, memoryContent, setAgents } = args
  const [savingMemory, setSavingMemory] = useState(false)
  const [resettingSession, setResettingSession] = useState(false)

  const saveMemory = async (): Promise<void> => {
    if (!selectedAgentId) {
      return
    }
    setSavingMemory(true)
    try {
      await window.api.agents.writeFile(selectedAgentId, 'memory', memoryContent)
      toast.success('Memory saved')
    } catch (error) {
      console.error('Failed to save memory:', error)
      toast.error(error instanceof Error ? error.message : 'Could not save memory')
    } finally {
      setSavingMemory(false)
    }
  }

  const resetSession = async (): Promise<void> => {
    if (!selectedAgentId) {
      return
    }
    setResettingSession(true)
    try {
      setAgents(await window.api.agents.resetSession(selectedAgentId))
      toast.success('New session will start on next run')
    } catch (error) {
      console.error('Failed to reset session:', error)
      toast.error(error instanceof Error ? error.message : 'Could not reset session')
    } finally {
      setResettingSession(false)
    }
  }

  const saveTagline = async (value: string): Promise<void> => {
    if (!selectedAgent || value === selectedAgent.description) {
      return
    }
    try {
      setAgents(await window.api.agents.update(selectedAgent.id, { description: value }))
    } catch (error) {
      console.error('Failed to save tagline:', error)
      toast.error(error instanceof Error ? error.message : 'Could not save tagline')
    }
  }

  return { savingMemory, resettingSession, saveMemory, resetSession, saveTagline }
}

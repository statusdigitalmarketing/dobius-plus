import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AgentDraftComment } from '../../../../shared/agents'

export function useAgentDrafts(): {
  drafts: AgentDraftComment[]
  hasAsanaToken: boolean | null
  loadDrafts: () => Promise<void>
  approveDraft: (id: string) => Promise<void>
  discardDraft: (id: string) => Promise<void>
} {
  const [drafts, setDrafts] = useState<AgentDraftComment[]>([])
  const [hasAsanaToken, setHasAsanaToken] = useState<boolean | null>(null)

  const loadDrafts = useCallback(async (): Promise<void> => {
    setDrafts(await window.api.agents.listDrafts())
  }, [])

  const loadAsanaTokenState = useCallback(async (): Promise<void> => {
    setHasAsanaToken(await window.api.asana.hasToken())
  }, [])

  useEffect(() => {
    void loadDrafts()
    void loadAsanaTokenState()
  }, [loadAsanaTokenState, loadDrafts])

  const approveDraft = useCallback(
    async (id: string): Promise<void> => {
      await window.api.agents.approveDraft(id)
      await loadDrafts()
    },
    [loadDrafts]
  )

  const discardDraft = useCallback(
    async (id: string): Promise<void> => {
      try {
        await window.api.agents.discardDraft(id)
        await loadDrafts()
      } catch (error) {
        console.error('Failed to discard draft:', error)
        toast.error(error instanceof Error ? error.message : 'Could not discard draft')
      }
    },
    [loadDrafts]
  )

  return { drafts, hasAsanaToken, loadDrafts, approveDraft, discardDraft }
}

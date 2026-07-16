import { useEffect } from 'react'
import { toast } from 'sonner'

export function useAgentPageInitialLoad({
  loadAgents,
  loadRuns,
  loadBriefing,
  loadPaused
}: {
  loadAgents: () => Promise<void>
  loadRuns: () => Promise<void>
  loadBriefing: () => Promise<void>
  loadPaused: () => Promise<void>
}): void {
  useEffect(() => {
    void loadAgents().catch((error) => {
      console.error('Failed to load agents:', error)
      toast.error('Could not load agents')
    })
    void loadRuns().catch((error) => {
      console.error('Failed to load agent runs:', error)
      toast.error('Could not load agent runs')
    })
    void loadBriefing().catch((error) => {
      console.error('Failed to load briefing:', error)
      toast.error('Could not load briefing')
    })
    void loadPaused().catch((error) => {
      console.error('Failed to load crew pause state:', error)
    })
  }, [loadAgents, loadRuns, loadBriefing, loadPaused])
}

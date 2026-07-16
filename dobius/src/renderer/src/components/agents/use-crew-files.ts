import { useState } from 'react'
import { toast } from 'sonner'
import type { AgentCrewFileName, AgentCrewFiles } from '../../../../shared/agents'

const DEFAULT_CREW_FILES: AgentCrewFiles = {
  USER: '',
  TOOLS: ''
}

// Crew-wide USER.md / TOOLS.md dialog state: load on open, save both on save.
export function useCrewFiles(): {
  crewFilesOpen: boolean
  setCrewFilesOpen: (open: boolean) => void
  crewFiles: AgentCrewFiles
  setCrewFiles: (files: AgentCrewFiles) => void
  activeCrewFile: AgentCrewFileName
  setActiveCrewFile: (name: AgentCrewFileName) => void
  savingCrewFiles: boolean
  openCrewFiles: () => Promise<void>
  saveCrewFiles: () => Promise<void>
} {
  const [crewFilesOpen, setCrewFilesOpen] = useState(false)
  const [crewFiles, setCrewFiles] = useState<AgentCrewFiles>(DEFAULT_CREW_FILES)
  const [activeCrewFile, setActiveCrewFile] = useState<AgentCrewFileName>('USER')
  const [savingCrewFiles, setSavingCrewFiles] = useState(false)

  const openCrewFiles = async (): Promise<void> => {
    try {
      setCrewFiles(await window.api.agents.readCrewFiles())
      setCrewFilesOpen(true)
    } catch (error) {
      console.error('Failed to load crew files:', error)
      toast.error('Could not load crew files')
    }
  }

  const saveCrewFiles = async (): Promise<void> => {
    setSavingCrewFiles(true)
    try {
      await Promise.all(
        (['USER', 'TOOLS'] as const).map((name) =>
          window.api.agents.writeCrewFile(name, crewFiles[name])
        )
      )
      setCrewFilesOpen(false)
      toast.success('Crew files saved')
    } catch (error) {
      console.error('Failed to save crew files:', error)
      toast.error(error instanceof Error ? error.message : 'Could not save crew files')
    } finally {
      setSavingCrewFiles(false)
    }
  }

  return {
    crewFilesOpen,
    setCrewFilesOpen,
    crewFiles,
    setCrewFiles,
    activeCrewFile,
    setActiveCrewFile,
    savingCrewFiles,
    openCrewFiles,
    saveCrewFiles
  }
}

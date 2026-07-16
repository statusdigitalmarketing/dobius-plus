import type { TuiAgent } from './types'

export type AsanaProjectRef = {
  name: string
  gid: string
}

export type AsanaConfig = {
  myGid: string
  reviewGid: string
  allowedProjects: AsanaProjectRef[]
  autoMode: {
    enabled: boolean
    intervalMinutes: number
    triageAgentId?: string
    buildAgent?: TuiAgent
  }
}

export const DEFAULT_ASANA_CONFIG: AsanaConfig = {
  myGid: '1215600517617968',
  reviewGid: '1213473231797717',
  allowedProjects: [],
  autoMode: {
    enabled: false,
    intervalMinutes: 10,
    buildAgent: 'claude'
  }
}

export type AsanaLane = 'build' | 'review'

export type AsanaTask = {
  gid: string
  name: string
  notes: string
  url: string
  dueOn: string | null
  completed: boolean
  lane: AsanaLane
  assignee: string | null
}

export type AsanaTasksSnapshot = {
  build: AsanaTask[]
  review: AsanaTask[]
  localDone: string[]
  lastSync: number | null
  error: string | null
}

export const EMPTY_ASANA_SNAPSHOT: AsanaTasksSnapshot = {
  build: [],
  review: [],
  localDone: [],
  lastSync: null,
  error: null
}

// Renderer never gets the PAT; a valid Asana task gid is 6-30 digits.
export const ASANA_GID_RE = /^\d{6,30}$/

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentRun } from '../../shared/agents'

const RUNS_FILE_NAME = 'agents-runs.json'
const MAX_RUNS = 50

let cachedRuns: AgentRun[] | null = null

function runsPath(): string {
  return path.join(app.getPath('userData'), RUNS_FILE_NAME)
}

function sanitizeRuns(raw: unknown): AgentRun[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const record = entry as Partial<Record<keyof AgentRun, unknown>>
    const id = typeof record.id === 'string' ? record.id : ''
    const agentId = typeof record.agentId === 'string' ? record.agentId : ''
    const prompt = typeof record.prompt === 'string' ? record.prompt : ''
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : 0
    if (!id || !agentId || !startedAt) {
      return []
    }
    const status =
      record.status === 'success' ||
      record.status === 'error' ||
      record.status === 'cancelled' ||
      record.status === 'running'
        ? record.status
        : 'error'
    const run: AgentRun = {
      id,
      agentId,
      prompt,
      source:
        record.source === 'heartbeat' || record.source === 'channel' || record.source === 'asana'
          ? record.source
          : 'manual',
      startedAt,
      status: status === 'running' ? 'error' : status,
      summary:
        status === 'running'
          ? 'app restarted during run'
          : typeof record.summary === 'string'
            ? record.summary
            : undefined
    }
    if (typeof record.endedAt === 'number' || status === 'running') {
      run.endedAt = typeof record.endedAt === 'number' ? record.endedAt : Date.now()
    }
    if (typeof record.numTurns === 'number') {
      run.numTurns = record.numTurns
    }
    if (typeof record.costUsd === 'number') {
      run.costUsd = record.costUsd
    }
    return [run]
  })
}

function loadRuns(): AgentRun[] {
  if (cachedRuns) {
    return cachedRuns
  }
  try {
    cachedRuns = sanitizeRuns(JSON.parse(readFileSync(runsPath(), 'utf-8')))
  } catch {
    cachedRuns = []
  }
  cachedRuns = cachedRuns.slice(-MAX_RUNS)
  persistRuns(cachedRuns)
  return cachedRuns
}

function persistRuns(runs: AgentRun[]): void {
  const target = runsPath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(runs.slice(-MAX_RUNS), null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[agents] failed to persist runs:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function addStoredAgentRun(run: AgentRun): AgentRun[] {
  const runs = loadRuns()
  runs.push(run)
  cachedRuns = runs.slice(-MAX_RUNS)
  persistRuns(cachedRuns)
  return listStoredAgentRuns()
}

export function updateStoredAgentRun(runId: string, updates: Partial<AgentRun>): AgentRun | null {
  const runs = loadRuns()
  const run = runs.find((entry) => entry.id === runId)
  if (!run) {
    return null
  }
  Object.assign(run, updates)
  cachedRuns = runs.slice(-MAX_RUNS)
  persistRuns(cachedRuns)
  return { ...run }
}

export function getStoredAgentRun(runId: string): AgentRun | null {
  const run = loadRuns().find((entry) => entry.id === runId)
  return run ? { ...run } : null
}

export function listStoredAgentRuns(): AgentRun[] {
  return loadRuns().map((run) => ({ ...run }))
}

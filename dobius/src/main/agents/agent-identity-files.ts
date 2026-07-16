import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentCrewFileName,
  AgentCrewFiles,
  AgentIdentityFileName,
  AgentReadableFiles
} from '../../shared/agents'

const IDENTITY_FILE_NAMES: AgentIdentityFileName[] = ['soul', 'role', 'playbook', 'rules']
const CREW_FILE_NAMES: AgentCrewFileName[] = ['USER', 'TOOLS']

const IDENTITY_TEMPLATES: Record<AgentIdentityFileName, string> = {
  soul: 'How does this agent think and talk? Values, tone, when to speak vs stay silent.\n',
  role: 'The job. What do they own, what do they watch, what does "done" look like?\n',
  playbook:
    'How they work: numbered steps, output format, conventions.\n1. Read memory first.\n2. ...\n',
  rules: 'Hard boundaries, one per line.\nNever push without approval.\n'
}

const CREW_TEMPLATES: AgentCrewFiles = {
  USER: 'What should every agent know about the user? Preferences, recurring context, names, and working style.\n',
  TOOLS:
    'House tool conventions shared by every agent. Include commands, repo habits, and approval expectations.\n'
}

const MEMORY_TEMPLATE = '- Add durable facts this agent should remember here.\n'
const BRIEF_TEMPLATE =
  'What should this agent report in the morning brief? One directive paragraph.\n'
const PROGRESS_LOG_TEMPLATE = ''

export type AgentPromptFiles = AgentReadableFiles & {
  progressLog: string
  crewUser: string
  crewTools: string
}

function agentsRoot(): string {
  return path.join(os.homedir(), '.dobius', 'agents')
}

// Why: agentId arrives over IPC — without this check '../..' escapes the agents
// root into arbitrary filesystem reads/writes.
function assertSafeAgentId(agentId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(agentId)) {
    throw new Error(`Invalid agent id: ${agentId}`)
  }
}

function agentDir(agentId: string): string {
  assertSafeAgentId(agentId)
  return path.join(agentsRoot(), agentId)
}

function crewDir(): string {
  return path.join(agentsRoot(), '_crew')
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, filePath)
}

function readOrCreate(filePath: string, template: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      throw error
    }
    atomicWrite(filePath, template)
    return template
  }
}

function assertIdentityFileName(
  name: string
): asserts name is AgentIdentityFileName | 'brief' | 'memory' {
  if (
    ![...IDENTITY_FILE_NAMES, 'brief', 'memory'].includes(
      name as AgentIdentityFileName | 'brief' | 'memory'
    )
  ) {
    throw new Error(`Unsupported agent file: ${name}`)
  }
}

function assertCrewFileName(name: string): asserts name is AgentCrewFileName {
  if (!CREW_FILE_NAMES.includes(name as AgentCrewFileName)) {
    throw new Error(`Unsupported crew file: ${name}`)
  }
}

export function agentMemoryFilePath(agentId: string): string {
  return path.join(agentDir(agentId), 'memory.md')
}

export function readAgentFiles(agentId: string): AgentReadableFiles {
  const dir = agentDir(agentId)
  return {
    soul: readOrCreate(path.join(dir, 'soul.md'), IDENTITY_TEMPLATES.soul),
    role: readOrCreate(path.join(dir, 'role.md'), IDENTITY_TEMPLATES.role),
    playbook: readOrCreate(path.join(dir, 'playbook.md'), IDENTITY_TEMPLATES.playbook),
    rules: readOrCreate(path.join(dir, 'rules.md'), IDENTITY_TEMPLATES.rules),
    brief: readOrCreate(path.join(dir, 'brief.md'), BRIEF_TEMPLATE),
    memory: readOrCreate(path.join(dir, 'memory.md'), MEMORY_TEMPLATE)
  }
}

export function writeAgentFile(
  agentId: string,
  name: AgentIdentityFileName | 'brief' | 'memory',
  content: string
): void {
  assertIdentityFileName(name)
  atomicWrite(path.join(agentDir(agentId), `${name}.md`), content)
}

export function readCrewFiles(): AgentCrewFiles {
  const dir = crewDir()
  return {
    USER: readOrCreate(path.join(dir, 'USER.md'), CREW_TEMPLATES.USER),
    TOOLS: readOrCreate(path.join(dir, 'TOOLS.md'), CREW_TEMPLATES.TOOLS)
  }
}

export function writeCrewFile(name: AgentCrewFileName, content: string): void {
  assertCrewFileName(name)
  atomicWrite(path.join(crewDir(), `${name}.md`), content)
}

// Why: templates are editing placeholders for humans — a file still identical to
// its template must not be injected into the agent's live system prompt.
function withoutTemplate(content: string, template: string): string {
  return content.trim() === template.trim() ? '' : content
}

export function readAgentPromptFiles(agentId: string): AgentPromptFiles {
  const files = readAgentFiles(agentId)
  const crew = readCrewFiles()
  return {
    soul: withoutTemplate(files.soul, IDENTITY_TEMPLATES.soul),
    role: withoutTemplate(files.role, IDENTITY_TEMPLATES.role),
    playbook: withoutTemplate(files.playbook, IDENTITY_TEMPLATES.playbook),
    rules: withoutTemplate(files.rules, IDENTITY_TEMPLATES.rules),
    brief: withoutTemplate(files.brief, BRIEF_TEMPLATE),
    memory: withoutTemplate(files.memory, MEMORY_TEMPLATE),
    progressLog: readOrCreate(
      path.join(agentDir(agentId), 'progress-log.md'),
      PROGRESS_LOG_TEMPLATE
    ),
    crewUser: withoutTemplate(crew.USER, CREW_TEMPLATES.USER),
    crewTools: withoutTemplate(crew.TOOLS, CREW_TEMPLATES.TOOLS)
  }
}

const PROGRESS_LOG_MAX_LINES = 400

export function appendAgentProgressLog(agentId: string, line: string): void {
  const filePath = path.join(agentDir(agentId), 'progress-log.md')
  const current = readOrCreate(filePath, PROGRESS_LOG_TEMPLATE)
  // Why: one line per run forever is unbounded — keep the on-disk log capped.
  const lines = [...current.split(/\r?\n/).filter(Boolean), line].slice(-PROGRESS_LOG_MAX_LINES)
  atomicWrite(filePath, `${lines.join('\n')}\n`)
}

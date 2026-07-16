import os from 'node:os'
import path from 'node:path'
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

type HardRailRunContext = {
  agentId: string
}

type HardRailDenial = {
  reason: string
}

function expandHome(value: string): string {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function normalizePathLike(value: string): string {
  return path.normalize(expandHome(value)).replace(/\\/g, '/')
}

function collectStrings(value: unknown, strings: string[] = []): string[] {
  if (typeof value === 'string') {
    strings.push(value)
    return strings
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, strings)
    }
    return strings
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      collectStrings(item, strings)
    }
  }
  return strings
}

function commandTriggersHardRail(toolName: string, input: unknown): HardRailDenial | null {
  if (toolName !== 'Bash' || typeof input !== 'object' || input === null) {
    return null
  }
  const command = (input as { command?: unknown }).command
  if (typeof command !== 'string') {
    return null
  }
  // Why: global options can sit between git and push (`git -C <path> push --force`),
  // so match them as separate tokens within one shell command (not across |;&).
  const gitPush = /\bgit\b(?:(?!(?:&&|;|\|))[^])*?\bpush\b/
  if (
    gitPush.test(command) &&
    /\bpush\b[\s\S]*(?:--force(?:-with-lease)?\b|(?:^|\s)-[A-Za-z]*f[A-Za-z]*\b)/.test(command)
  ) {
    return { reason: 'Hard rail: force-pushing is not allowed from agent runs.' }
  }
  // Why: `git push origin +branch` is refspec-syntax force-push — same rail.
  if (gitPush.test(command) && /\bpush\b[^|;&]*\s\+\S/.test(command)) {
    return { reason: 'Hard rail: force-pushing is not allowed from agent runs.' }
  }
  if (/\brm\s+(?:-[^\s]*r[^\s]*f|-+[^\s]*f[^\s]*r)\s+(?:--\s+)?\/(?:\*|\s|$)/.test(command)) {
    return { reason: 'Hard rail: recursive root deletes are not allowed from agent runs.' }
  }
  return null
}

function rawStringMentionsCredential(value: string): boolean {
  return (
    /(^|[\s"'=:/\\])\.env(?:\.[^\s"'`;&|]*)?(?=$|[\s"'`;&|])/i.test(value) ||
    /~[/\\]\.claude[/\\](?:\.credentials\.json|credentials[^\s"'`;&|]*)/i.test(value) ||
    /~[/\\]\.dobius[/\\].*[/\\]token[^\s"'`;&|]*/i.test(value) ||
    /~[/\\]Library[/\\]Keychains(?:[/\\]|\s|$)/i.test(value)
  )
}

const FILE_EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

// Why: for file-editing tools only the TARGET PATH matters — scanning the content
// payload false-denies writing ".env" into a .gitignore or a README that mentions it.
function stringsToInspect(toolName: string, input: unknown): string[] {
  if (FILE_EDIT_TOOLS.includes(toolName) && typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    return ['file_path', 'path', 'notebook_path']
      .map((key) => record[key])
      .filter((value): value is string => typeof value === 'string')
  }
  return collectStrings(input)
}

function targetsCredentials(toolName: string, input: unknown): HardRailDenial | null {
  const home = normalizePathLike(os.homedir())
  const credentialPrefixes = [
    `${home}/.claude/.credentials.json`,
    `${home}/.claude/credentials`,
    `${home}/.dobius/`,
    `${home}/Library/Keychains`
  ]
  for (const raw of stringsToInspect(toolName, input)) {
    if (rawStringMentionsCredential(raw)) {
      return { reason: 'Hard rail: credential material is not available to agents.' }
    }
    const normalized = normalizePathLike(raw)
    const basename = path.basename(normalized)
    if (basename === '.env' || basename.startsWith('.env.')) {
      return { reason: 'Hard rail: credential environment files are not available to agents.' }
    }
    if (
      credentialPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix))
    ) {
      if (!normalized.includes('/.dobius/') || /\/token[^/]*$/i.test(normalized)) {
        return { reason: 'Hard rail: credential material is not available to agents.' }
      }
    }
  }
  return null
}

function targetsOtherAgentIdentity(
  context: HardRailRunContext,
  toolName: string,
  input: unknown
): HardRailDenial | null {
  // Why: Bash can cp/cat/rm another agent's files just as well as Write/Edit can —
  // the isolation rail must cover shell commands too.
  if (!FILE_EDIT_TOOLS.includes(toolName) && toolName !== 'Bash') {
    return null
  }
  const agentsRoot = `${normalizePathLike(path.join(os.homedir(), '.dobius', 'agents'))}/`
  // Why: inside a Bash command the agents dir appears mid-string (often via ~),
  // so a startsWith check misses it — scan for every reference instead.
  const referencePattern = /(?:~|\/[^\s"'`;&|]*?)\/\.dobius\/agents\/([^/\s"'`;&|]+)/g
  for (const raw of stringsToInspect(toolName, input)) {
    const normalized = normalizePathLike(raw)
    if (normalized.startsWith(agentsRoot)) {
      const targetAgentId = normalized.slice(agentsRoot.length).split('/')[0]
      if (targetAgentId && targetAgentId !== context.agentId) {
        return { reason: 'Hard rail: agents may not edit another agent identity or memory.' }
      }
    }
    for (const match of raw.matchAll(referencePattern)) {
      const targetAgentId = match[1]
      if (targetAgentId && targetAgentId !== context.agentId) {
        return { reason: 'Hard rail: agents may not edit another agent identity or memory.' }
      }
    }
  }
  return null
}

export function evaluateAgentHardRails(
  context: HardRailRunContext,
  toolName: string,
  input: unknown
): HardRailDenial | null {
  return (
    commandTriggersHardRail(toolName, input) ??
    targetsCredentials(toolName, input) ??
    targetsOtherAgentIdentity(context, toolName, input)
  )
}

export function buildAgentHardRailHooks(context: HardRailRunContext): {
  PreToolUse: HookCallbackMatcher[]
} {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input): Promise<HookJSONOutput> => {
            if (input.hook_event_name !== 'PreToolUse') {
              return { continue: true }
            }
            const denial = evaluateAgentHardRails(context, input.tool_name, input.tool_input)
            if (!denial) {
              return { continue: true }
            }
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: denial.reason
              }
            }
          }
        ]
      }
    ]
  }
}

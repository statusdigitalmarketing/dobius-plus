import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

function cloneProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

export function buildRunEnv(preparation: ClaudeRuntimeAuthPreparation): Options['env'] {
  return applyClaudeEnvPatch(cloneProcessEnv(), preparation.envPatch, {
    stripAuthEnv: preparation.stripAuthEnv
  })
}

export function resolveAgentRunCwd(cwd: string): string {
  if (!cwd) {
    return os.homedir()
  }
  if (cwd === '~') {
    return os.homedir()
  }
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    return path.join(os.homedir(), cwd.slice(2))
  }
  return path.resolve(cwd)
}

export function currentGitBranch(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      return undefined
    }
    console.warn(
      '[agents] failed to read git branch:',
      error instanceof Error ? error.message : String(error)
    )
    return undefined
  }
}

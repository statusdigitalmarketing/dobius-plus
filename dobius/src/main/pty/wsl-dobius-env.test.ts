import { describe, expect, it } from 'vitest'
import { addDobiusWslInteropEnv } from './wsl-dobius-env'

describe('addDobiusWslInteropEnv', () => {
  it('marks the Dobius terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { DOBIUS_TERMINAL_HANDLE: 'term_wsl' }

    addDobiusWslInteropEnv(env)

    expect(env.WSLENV).toBe('DOBIUS_TERMINAL_HANDLE/u')
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:DOBIUS_TERMINAL_HANDLE/u:BAR/p'
    }

    addDobiusWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:DOBIUS_TERMINAL_HANDLE/u:BAR/p')
  })

  it('marks OMP status and hook env for Windows to WSL import', () => {
    const env: Record<string, string> = {
      DOBIUS_TERMINAL_HANDLE: 'term_wsl',
      DOBIUS_OMP_STATUS_EXTENSION: 'C:\\Users\\jin\\.omp\\agent\\extensions\\dobius-agent-status.ts',
      DOBIUS_PANE_KEY: 'tab-1:leaf-1',
      DOBIUS_TAB_ID: 'tab-1',
      DOBIUS_WORKTREE_ID: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
      DOBIUS_AGENT_HOOK_PORT: '4567',
      DOBIUS_AGENT_HOOK_TOKEN: 'token',
      DOBIUS_AGENT_HOOK_ENV: 'dev',
      DOBIUS_AGENT_HOOK_VERSION: '1'
    }

    addDobiusWslInteropEnv(env)

    expect(env.WSLENV).toContain('DOBIUS_TERMINAL_HANDLE/u')
    expect(env.WSLENV).toContain('DOBIUS_OMP_STATUS_EXTENSION/p')
    expect(env.WSLENV).toContain('DOBIUS_PANE_KEY/u')
    expect(env.WSLENV).toContain('DOBIUS_TAB_ID/u')
    expect(env.WSLENV).toContain('DOBIUS_WORKTREE_ID/u')
    expect(env.WSLENV).toContain('DOBIUS_AGENT_HOOK_PORT/u')
    expect(env.WSLENV).toContain('DOBIUS_AGENT_HOOK_TOKEN/u')
    expect(env.WSLENV).toContain('DOBIUS_AGENT_HOOK_ENV/u')
    expect(env.WSLENV).toContain('DOBIUS_AGENT_HOOK_VERSION/u')
  })
})

import { describe, expect, it } from 'vitest'
import { evaluateAgentHardRails } from './agent-hard-rails'

const ctx = { agentId: 'agent-a' }

describe('agent hard rails', () => {
  it('denies force-push including global-option and refspec forms', () => {
    expect(evaluateAgentHardRails(ctx, 'Bash', { command: 'git push --force' })).not.toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Bash', { command: 'git push -f origin main' })
    ).not.toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Bash', { command: 'git -C /tmp/wt push --force-with-lease' })
    ).not.toBeNull()
    expect(evaluateAgentHardRails(ctx, 'Bash', { command: 'git push origin +main' })).not.toBeNull()
  })

  it('allows normal git usage', () => {
    expect(evaluateAgentHardRails(ctx, 'Bash', { command: 'git push origin main' })).toBeNull()
    expect(evaluateAgentHardRails(ctx, 'Bash', { command: 'git commit -m "fix"' })).toBeNull()
  })

  it('denies credential targets but not content that merely mentions .env', () => {
    expect(evaluateAgentHardRails(ctx, 'Read', { file_path: '/repo/.env' })).not.toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Bash', { command: 'cat ~/.claude/.credentials.json' })
    ).not.toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Write', {
        file_path: '/repo/.gitignore',
        content: '.env\nnode_modules\n'
      })
    ).toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Write', { file_path: '/repo/.env', content: 'X=1' })
    ).not.toBeNull()
  })

  it('isolates agent identities across Write and Bash', () => {
    const home = process.env.HOME ?? ''
    expect(
      evaluateAgentHardRails(ctx, 'Write', {
        file_path: `${home}/.dobius/agents/agent-b/memory.md`,
        content: 'x'
      })
    ).not.toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Bash', { command: 'cat ~/.dobius/agents/agent-b/soul.md' })
    ).not.toBeNull()
    expect(
      evaluateAgentHardRails(ctx, 'Write', {
        file_path: `${home}/.dobius/agents/agent-a/memory.md`,
        content: 'x'
      })
    ).toBeNull()
  })
})

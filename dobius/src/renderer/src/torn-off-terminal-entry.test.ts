import { describe, expect, it } from 'vitest'
import { parseTornOffTerminalHash } from './torn-off-terminal-entry'

describe('parseTornOffTerminalHash', () => {
  it('parses a valid torn-off terminal hash', () => {
    expect(parseTornOffTerminalHash('#terminal-tab=tab-1&pty=pty-1&title=Shell%201')).toEqual({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      title: 'Shell 1',
      worktreeId: null,
      worktreeName: null
    })
  })

  it('carries origin worktree id and name when present', () => {
    expect(
      parseTornOffTerminalHash(
        '#terminal-tab=tab-1&pty=pty-1&title=Shell%201&worktree=repo%3A%3A%2Ftmp%2Fp&worktree-name=dobius-plus'
      )
    ).toEqual({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      title: 'Shell 1',
      worktreeId: 'repo::/tmp/p',
      worktreeName: 'dobius-plus'
    })
  })

  it('rejects invalid terminal tab ids', () => {
    expect(parseTornOffTerminalHash('#terminal-tab=bad:tab&pty=pty-1')).toBeNull()
  })

  it('rejects hashes without a pty id', () => {
    expect(parseTornOffTerminalHash('#terminal-tab=tab-1')).toBeNull()
  })
})

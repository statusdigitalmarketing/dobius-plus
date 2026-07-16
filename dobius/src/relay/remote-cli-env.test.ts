import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Dobius terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        DOBIUS_TERMINAL_HANDLE: 'term_ssh',
        DOBIUS_WORKTREE_ID: 'repo::remote',
        DOBIUS_USER_DATA_PATH: '/tmp/dobius',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      DOBIUS_TERMINAL_HANDLE: 'term_ssh',
      DOBIUS_WORKTREE_ID: 'repo::remote',
      DOBIUS_USER_DATA_PATH: '/tmp/dobius',
      PATH: '/usr/bin'
    })
  })
})

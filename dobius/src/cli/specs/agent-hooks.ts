import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Dobius-managed agent status hooks are enabled',
    usage: 'dobius agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['dobius agent hooks status', 'dobius agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Dobius-managed agent status hooks and remove local hook entries',
    usage: 'dobius agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['dobius agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Dobius-managed agent status hooks',
    usage: 'dobius agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['dobius agent hooks on']
  }
]

import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const AGENT_FIELD_FLAGS = [
  'name',
  'description',
  'system-prompt',
  'model',
  'tools',
  'skills',
  'cwd'
]

const AGENT_VS_AUTOMATION_NOTE =
  'Agents are the persistent Claude SDK personas shown in the Agents tab. For scheduled terminal runs (the Automations tab), use `automations create` instead.'

export const CUSTOM_AGENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agents', 'list'],
    summary: 'List Agents-tab agents (persistent Claude SDK agents)',
    usage: 'dobius agents list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [AGENT_VS_AUTOMATION_NOTE],
    examples: ['dobius agents list', 'dobius agents list --json']
  },
  {
    path: ['agents', 'show'],
    summary: 'Show one Agents-tab agent',
    usage: 'dobius agents show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['dobius agents show 2f9e...', 'dobius agents show --id 2f9e... --json']
  },
  {
    path: ['agents', 'create'],
    summary: 'Create an agent in the Agents tab',
    usage:
      'dobius agents create --name <name> [--description <text>] [--system-prompt <text>] [--model <id>] [--tools <a,b>] [--skills <a,b>] [--cwd <path>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...AGENT_FIELD_FLAGS],
    notes: [
      AGENT_VS_AUTOMATION_NOTE,
      'Tools and skills accept comma-separated lists; tools default to Read, Grep, Glob.',
      'Icon, color, heartbeat, notification, and permission-bypass settings are editable only in the app UI.'
    ],
    examples: [
      'dobius agents create --name "Code Reviewer" --system-prompt "Review diffs for bugs" --tools "Read,Grep,Glob,Bash"',
      'dobius agents create --name "Docs Writer" --model claude-fable-5 --cwd ~/Projects --json'
    ]
  },
  {
    path: ['agents', 'edit'],
    summary: 'Edit an Agents-tab agent',
    usage: 'dobius agents edit <id> [--name <name>] [--system-prompt <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', ...AGENT_FIELD_FLAGS],
    positionalArgs: ['id'],
    examples: [
      'dobius agents edit 2f9e... --model claude-fable-5',
      'dobius agents edit --id 2f9e... --tools "Read,Grep,Glob,Bash" --json'
    ]
  },
  {
    path: ['agents', 'remove'],
    summary: 'Remove an Agents-tab agent',
    usage: 'dobius agents remove <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['dobius agents remove 2f9e...', 'dobius agents remove --id 2f9e... --json']
  },
  {
    path: ['agents', 'run'],
    summary: 'Run an Agents-tab agent now with a prompt',
    usage: 'dobius agents run <id> --prompt <text> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'prompt'],
    positionalArgs: ['id'],
    notes: ['Requires the Dobius+ app to be running; the run executes via the Claude Agent SDK.'],
    examples: ['dobius agents run 2f9e... --prompt "Summarize open PRs"']
  },
  {
    path: ['agents', 'runs'],
    summary: 'List agent run history',
    usage: 'dobius agents runs [--id <agent-id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    examples: ['dobius agents runs', 'dobius agents runs --id 2f9e... --json']
  }
]

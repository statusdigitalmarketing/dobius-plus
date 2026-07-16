import type { AgentReadableFiles } from '../../../../shared/agents'

export const DEFAULT_AGENT_FILES: AgentReadableFiles = {
  soul: 'How does this agent think and talk? Values, tone, when to speak vs stay silent.\n',
  role: 'The job. What do they own, what do they watch, what does "done" look like?\n',
  playbook:
    'How they work: numbered steps, output format, conventions.\n1. Read memory first.\n2. ...\n',
  rules: 'Hard boundaries, one per line.\nNever push without approval.\n',
  brief: 'What should this agent report in the morning brief? One directive paragraph.\n',
  memory: '- Add durable facts this agent should remember here.\n'
}

import { buildDobiusToolServer } from './agent-tools/dobius-tool-server'

const DOBIUS_TOOL_ALLOW_RULE = 'mcp__dobius__*'

export function withDobiusToolAllowRule(tools: string[]): string[] {
  return tools.includes(DOBIUS_TOOL_ALLOW_RULE) ? tools : [...tools, DOBIUS_TOOL_ALLOW_RULE]
}

export function buildDobiusRunMcpServer(agentId: string, runId: string) {
  return buildDobiusToolServer({ agentId, runId })
}

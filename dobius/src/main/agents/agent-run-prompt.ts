import type { CustomAgent } from '../../shared/agents'
import { readAgentPromptFiles } from './agent-identity-files'

function progressLogRecentLines(content: string): string {
  return content.split(/\r?\n/).filter(Boolean).slice(-40).join('\n')
}

function addPromptSection(sections: string[], heading: string, content: string): void {
  const text = content.trim()
  if (text) {
    sections.push(`## ${heading}\n\n${text}`)
  }
}

export function buildSystemPrompt(agent: CustomAgent): string {
  const files = readAgentPromptFiles(agent.id)
  const sections: string[] = []
  // Why: old agents may still carry their instructions only in systemPrompt.
  addPromptSection(sections, 'Instructions', agent.systemPrompt)
  addPromptSection(sections, 'Soul', files.soul)
  addPromptSection(sections, 'Role', files.role)
  addPromptSection(sections, 'Playbook', files.playbook)
  addPromptSection(sections, 'Briefing directive', files.brief)
  addPromptSection(sections, 'Rules', files.rules)
  addPromptSection(sections, 'About the user', files.crewUser)
  addPromptSection(sections, 'House tool conventions', files.crewTools)
  addPromptSection(sections, 'Memory', files.memory)
  addPromptSection(sections, 'Progress log (recent)', progressLogRecentLines(files.progressLog))
  return sections.join('\n\n')
}

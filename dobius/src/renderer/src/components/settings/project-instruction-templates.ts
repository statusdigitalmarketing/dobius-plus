import type { ProjectFileName } from '../../../../shared/project-files'

export function getProjectInstructionStarter(name: ProjectFileName, displayName: string): string {
  if (name === 'CLAUDE.md') {
    return `# ${displayName}\n\nAdd project instructions for Claude here.\n`
  }
  if (name === 'AGENTS.md') {
    return `# ${displayName}\n\nAdd project instructions for coding agents here.\n`
  }
  if (name.startsWith('.claude/rules/')) {
    return `# ${name.slice('.claude/rules/'.length, -'.md'.length)}\n\n`
  }
  return ''
}

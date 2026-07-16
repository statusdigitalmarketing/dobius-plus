import { describe, expect, it } from 'vitest'
import {
  buildAgentFeatureSkillInstallCommand,
  buildAgentFeatureSkillUpdateCommand,
  COMPUTER_USE_SKILL_UPDATE_COMMAND,
  EPHEMERAL_VMS_SKILL_UPDATE_COMMAND,
  LINEAR_TICKETS_SKILL_UPDATE_COMMAND,
  DOBIUS_LINEAR_SKILL_UPDATE_COMMAND,
  DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND,
  DOBIUS_CLI_SKILL_UPDATE_COMMAND,
  ORCHESTRATION_SKILL_UPDATE_COMMAND
} from './agent-feature-install-commands'

describe('agent feature skill commands', () => {
  it('builds single-skill update commands', () => {
    expect(buildAgentFeatureSkillUpdateCommand('orchestration')).toBe(
      'Reinstall bundled skill: orchestration'
    )
  })

  it('trims and rejects blank update skill names', () => {
    expect(buildAgentFeatureSkillUpdateCommand('  dobius-cli  ')).toBe(
      'Reinstall bundled skill: dobius-cli'
    )
    expect(() => buildAgentFeatureSkillUpdateCommand('   ')).toThrow('A skill name is required.')
  })

  it('exports single-skill update constants without changing install bundles', () => {
    expect(DOBIUS_CLI_SKILL_UPDATE_COMMAND).toBe('Reinstall bundled skill: dobius-cli')
    expect(COMPUTER_USE_SKILL_UPDATE_COMMAND).toBe('Reinstall bundled skill: computer-use')
    expect(ORCHESTRATION_SKILL_UPDATE_COMMAND).toBe('Reinstall bundled skill: orchestration')
    expect(EPHEMERAL_VMS_SKILL_UPDATE_COMMAND).toBe(
      'Reinstall bundled skill: dobius-per-workspace-env'
    )
    expect(DOBIUS_LINEAR_SKILL_UPDATE_COMMAND).toBe('Reinstall bundled skill: dobius-linear')
    expect(LINEAR_TICKETS_SKILL_UPDATE_COMMAND).toBe('Reinstall bundled skill: linear-tickets')
    expect(DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND).toBe(
      buildAgentFeatureSkillInstallCommand(['dobius-cli', 'orchestration'])
    )
  })
})

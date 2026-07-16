export const DOBIUS_CLI_SKILL_NAME = 'dobius-cli'
export const DOBIUS_EMULATOR_SKILL_NAME = 'dobius-emulator'
export const COMPUTER_USE_SKILL_NAME = 'computer-use'
export const ORCHESTRATION_SKILL_NAME = 'orchestration'
export const EPHEMERAL_VMS_SKILL_NAME = 'dobius-per-workspace-env'
export const DOBIUS_LINEAR_SKILL_NAME = 'dobius-linear'
export const LINEAR_TICKETS_SKILL_NAME = 'linear-tickets'
export const LINEAR_AGENT_SKILL_NAMES = [
  DOBIUS_LINEAR_SKILL_NAME,
  LINEAR_TICKETS_SKILL_NAME
] as const

export function buildAgentFeatureSkillInstallCommand(skillNames: readonly string[]): string {
  if (skillNames.length === 0) {
    throw new Error('At least one skill name is required.')
  }
  return `Install bundled skill: ${skillNames.join(', ')}`
}

export function buildAgentFeatureSkillUpdateCommand(skillName: string): string {
  const trimmedSkillName = skillName.trim()
  if (!trimmedSkillName) {
    throw new Error('A skill name is required.')
  }
  return `Reinstall bundled skill: ${trimmedSkillName}`
}

export const DOBIUS_CLI_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  DOBIUS_CLI_SKILL_NAME
])

export const DOBIUS_CLI_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(DOBIUS_CLI_SKILL_NAME)

export const DOBIUS_EMULATOR_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  DOBIUS_EMULATOR_SKILL_NAME
])

export const DOBIUS_EMULATOR_SKILL_UPDATE_COMMAND = buildAgentFeatureSkillUpdateCommand(
  DOBIUS_EMULATOR_SKILL_NAME
)

export const COMPUTER_USE_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  COMPUTER_USE_SKILL_NAME
])

export const COMPUTER_USE_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(COMPUTER_USE_SKILL_NAME)

export const ORCHESTRATION_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  ORCHESTRATION_SKILL_NAME
])

export const ORCHESTRATION_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(ORCHESTRATION_SKILL_NAME)

export const EPHEMERAL_VMS_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  EPHEMERAL_VMS_SKILL_NAME
])

export const EPHEMERAL_VMS_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(EPHEMERAL_VMS_SKILL_NAME)

export const DOBIUS_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  DOBIUS_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
])

export const DOBIUS_LINEAR_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  DOBIUS_LINEAR_SKILL_NAME
])

export const DOBIUS_LINEAR_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(DOBIUS_LINEAR_SKILL_NAME)

export const LINEAR_TICKETS_SKILL_INSTALL_COMMAND = buildAgentFeatureSkillInstallCommand([
  LINEAR_TICKETS_SKILL_NAME
])

export const LINEAR_TICKETS_SKILL_UPDATE_COMMAND =
  buildAgentFeatureSkillUpdateCommand(LINEAR_TICKETS_SKILL_NAME)

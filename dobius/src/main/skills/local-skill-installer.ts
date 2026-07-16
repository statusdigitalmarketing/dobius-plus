import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

const SKILL_FILE_NAME = 'SKILL.md'

export const BUNDLED_SKILL_NAMES = [
  'dobius-cli',
  'dobius-emulator',
  'orchestration',
  'computer-use',
  'dobius-emulator-android',
  'dobius-per-workspace-env',
  'dobius-linear',
  'linear-tickets'
] as const

export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number]

export type BundledSkillInstallResult = {
  installed: boolean
  path: string
}

type LocalSkillInstallerOptions = {
  appPath?: string
  homeDir?: string
  resourcesPath?: string
  packaged?: boolean
}

const BUNDLED_SKILL_NAME_SET = new Set<string>(BUNDLED_SKILL_NAMES)

function assertBundledSkillName(skillName: string): BundledSkillName {
  const trimmed = skillName.trim()
  if (!BUNDLED_SKILL_NAME_SET.has(trimmed)) {
    throw new Error(`Unknown bundled skill: ${skillName}`)
  }
  return trimmed as BundledSkillName
}

function getBundledSkillSourcePath(
  skillName: BundledSkillName,
  options: LocalSkillInstallerOptions
): string {
  if (options.packaged ?? app.isPackaged) {
    return join(options.resourcesPath ?? process.resourcesPath, 'skills', skillName)
  }
  return join(options.appPath ?? app.getAppPath(), 'skills', skillName)
}

function getBundledSkillInstallPath(
  skillName: BundledSkillName,
  options: LocalSkillInstallerOptions
): string {
  return join(options.homeDir ?? homedir(), '.claude', 'skills', skillName)
}

async function validateSkillSource(sourcePath: string, skillName: string): Promise<void> {
  try {
    const sourceStat = await stat(sourcePath)
    if (!sourceStat.isDirectory()) {
      throw new Error(`Bundled skill source is not a directory: ${sourcePath}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Bundled skill source')) {
      throw error
    }
    throw new Error(`Bundled skill source was not found for ${skillName}: ${sourcePath}`)
  }

  const skillFilePath = join(sourcePath, SKILL_FILE_NAME)
  try {
    const skillFileStat = await stat(skillFilePath)
    if (!skillFileStat.isFile()) {
      throw new Error(`Bundled skill is missing ${SKILL_FILE_NAME}: ${skillFilePath}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Bundled skill is missing')) {
      throw error
    }
    throw new Error(`Bundled skill is missing ${SKILL_FILE_NAME}: ${skillFilePath}`)
  }
}

export async function installBundledSkill(
  skillName: string,
  options: LocalSkillInstallerOptions = {}
): Promise<BundledSkillInstallResult> {
  const bundledSkillName = assertBundledSkillName(skillName)
  const sourcePath = getBundledSkillSourcePath(bundledSkillName, options)
  await validateSkillSource(sourcePath, bundledSkillName)

  const installPath = getBundledSkillInstallPath(bundledSkillName, options)
  const installRoot = join(options.homeDir ?? homedir(), '.claude', 'skills')
  await mkdir(installRoot, { recursive: true })

  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const tempPath = join(installRoot, `.${bundledSkillName}.tmp-${uniqueSuffix}`)
  const backupPath = join(installRoot, `.${bundledSkillName}.backup-${uniqueSuffix}`)

  await cp(sourcePath, tempPath, { recursive: true, force: true, errorOnExist: false })

  let movedExistingToBackup = false
  try {
    if (existsSync(installPath)) {
      await rm(backupPath, { recursive: true, force: true })
      await rename(installPath, backupPath)
      movedExistingToBackup = true
    }
    await rename(tempPath, installPath)
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true })
    if (movedExistingToBackup && !existsSync(installPath)) {
      await rename(backupPath, installPath)
    }
    throw error
  } finally {
    await rm(backupPath, { recursive: true, force: true })
  }

  return { installed: true, path: installPath }
}

export async function isBundledSkillInstalled(
  skillName: string,
  options: LocalSkillInstallerOptions = {}
): Promise<boolean> {
  const bundledSkillName = assertBundledSkillName(skillName)
  const skillFilePath = join(getBundledSkillInstallPath(bundledSkillName, options), SKILL_FILE_NAME)
  try {
    const skillFileStat = await stat(skillFilePath)
    return skillFileStat.isFile()
  } catch {
    return false
  }
}

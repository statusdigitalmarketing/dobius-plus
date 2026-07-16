import { ipcMain } from 'electron'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import {
  ROOT_PROJECT_FILE_NAMES,
  type ProjectFileDeleteResult,
  type ProjectFileInfo,
  type ProjectFileName,
  type ProjectFileReadResult,
  type ProjectFilesListResult,
  type ProjectFileWriteResult
} from '../../shared/project-files'

const RULE_FILE_PREFIX = '.claude/rules/'
const RULE_FILE_SUFFIX = '.md'
const RULE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

type ProjectFileTarget = {
  name: ProjectFileName
  relativePath: string
  absolutePath: string
  repoRealPath: string
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function assertInsideRepo(resolvedPath: string, repoRealPath: string): void {
  if (resolvedPath !== repoRealPath && !resolvedPath.startsWith(`${repoRealPath}${path.sep}`)) {
    throw new Error('Project file path escapes the repository')
  }
}

function getRepo(store: Store, repoId: string): Repo {
  const repo = store.getRepos().find((entry) => entry.id === repoId)
  if (!repo) {
    throw new Error('Unknown repository')
  }
  return repo
}

export function normalizeProjectFileName(name: string): ProjectFileName {
  if ((ROOT_PROJECT_FILE_NAMES as readonly string[]).includes(name)) {
    return name as ProjectFileName
  }

  if (!name.startsWith(RULE_FILE_PREFIX) || !name.endsWith(RULE_FILE_SUFFIX)) {
    throw new Error('Project file is not allowed')
  }

  const ruleName = name.slice(RULE_FILE_PREFIX.length, -RULE_FILE_SUFFIX.length)
  if (!RULE_NAME_PATTERN.test(ruleName)) {
    throw new Error('Rule file name is not allowed')
  }

  return `${RULE_FILE_PREFIX}${ruleName}${RULE_FILE_SUFFIX}`
}

async function resolveProjectFileTarget(
  store: Store,
  repoId: string,
  requestedName: string
): Promise<ProjectFileTarget> {
  const repo = getRepo(store, repoId)
  const name = normalizeProjectFileName(requestedName)
  const repoPath = path.resolve(repo.path)
  const repoRealPath = await realpath(repoPath)
  const absolutePath = path.resolve(repoRealPath, name)

  // Why: the renderer sends only an allowlisted relative name, but this second
  // boundary check protects future edits from accidentally reintroducing traversal.
  assertInsideRepo(absolutePath, repoRealPath)

  return {
    name,
    relativePath: name,
    absolutePath,
    repoRealPath
  }
}

async function assertExistingTargetInsideRepo(target: ProjectFileTarget): Promise<void> {
  try {
    assertInsideRepo(await realpath(target.absolutePath), target.repoRealPath)
  } catch (error) {
    if (isNotFound(error)) {
      return
    }
    throw error
  }
}

async function assertNearestExistingAncestorInsideRepo(
  dirPath: string,
  repoRealPath: string
): Promise<void> {
  let current = dirPath
  while (current !== path.dirname(current)) {
    try {
      await stat(current)
      assertInsideRepo(await realpath(current), repoRealPath)
      return
    } catch (error) {
      if (!isNotFound(error)) {
        throw error
      }
      current = path.dirname(current)
    }
  }
  throw new Error('Project file path escapes the repository')
}

async function readInfo(name: ProjectFileName, absolutePath: string): Promise<ProjectFileInfo> {
  try {
    const stats = await stat(absolutePath)
    return { name, exists: stats.isFile(), size: stats.isFile() ? stats.size : 0 }
  } catch (error) {
    if (isNotFound(error)) {
      return { name, exists: false, size: 0 }
    }
    throw error
  }
}

async function listRuleFiles(repoRealPath: string): Promise<ProjectFileInfo[]> {
  const rulesDir = path.join(repoRealPath, '.claude', 'rules')
  try {
    assertInsideRepo(await realpath(rulesDir), repoRealPath)
    const entries = await readdir(rulesDir, { withFileTypes: true })
    const names = entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        try {
          return [normalizeProjectFileName(`${RULE_FILE_PREFIX}${entry.name}`)]
        } catch (error) {
          void error
          return []
        }
      })
      .sort()
    return Promise.all(names.map((name) => readInfo(name, path.join(repoRealPath, name))))
  } catch (error) {
    if (isNotFound(error)) {
      return []
    }
    throw error
  }
}

async function listProjectFiles(store: Store, repoId: string): Promise<ProjectFilesListResult> {
  const repo = getRepo(store, repoId)
  const repoRealPath = await realpath(path.resolve(repo.path))
  const rootFiles = await Promise.all(
    ROOT_PROJECT_FILE_NAMES.map((name) => readInfo(name, path.join(repoRealPath, name)))
  )
  const ruleFiles = await listRuleFiles(repoRealPath)
  return { rootFiles, ruleFiles }
}

async function readProjectFile(
  store: Store,
  repoId: string,
  requestedName: string
): Promise<ProjectFileReadResult> {
  const target = await resolveProjectFileTarget(store, repoId, requestedName)
  await assertExistingTargetInsideRepo(target)
  try {
    return {
      name: target.name,
      content: await readFile(target.absolutePath, 'utf-8'),
      exists: true
    }
  } catch (error) {
    if (isNotFound(error)) {
      return { name: target.name, content: '', exists: false }
    }
    throw error
  }
}

async function writeProjectFile(
  store: Store,
  repoId: string,
  requestedName: string,
  content: string
): Promise<ProjectFileWriteResult> {
  if (typeof content !== 'string') {
    throw new Error('Project file content must be a string')
  }
  const target = await resolveProjectFileTarget(store, repoId, requestedName)
  const parentDir = path.dirname(target.absolutePath)
  await assertNearestExistingAncestorInsideRepo(parentDir, target.repoRealPath)
  await mkdir(parentDir, { recursive: true })
  assertInsideRepo(await realpath(parentDir), target.repoRealPath)
  await assertExistingTargetInsideRepo(target)

  const tmp = path.join(parentDir, `.${path.basename(target.relativePath)}.${process.pid}.tmp`)
  await writeFile(tmp, content, 'utf-8')
  assertInsideRepo(await realpath(tmp), target.repoRealPath)
  await rename(tmp, target.absolutePath)
  const stats = await stat(target.absolutePath)
  return { name: target.name, size: stats.size }
}

async function deleteProjectFile(
  store: Store,
  repoId: string,
  requestedName: string
): Promise<ProjectFileDeleteResult> {
  const target = await resolveProjectFileTarget(store, repoId, requestedName)
  await assertExistingTargetInsideRepo(target)
  await rm(target.absolutePath, { force: true })
  return { name: target.name }
}

export function registerProjectFilesHandlers(store: Store): void {
  ipcMain.handle('project-files:list', (_event, repoId: string) => listProjectFiles(store, repoId))
  ipcMain.handle('project-files:read', (_event, repoId: string, name: string) =>
    readProjectFile(store, repoId, name)
  )
  ipcMain.handle('project-files:write', (_event, repoId: string, name: string, content: string) =>
    writeProjectFile(store, repoId, name, content)
  )
  ipcMain.handle('project-files:delete', (_event, repoId: string, name: string) =>
    deleteProjectFile(store, repoId, name)
  )
}

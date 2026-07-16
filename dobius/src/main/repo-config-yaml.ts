import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_CONFIG_YAML_NAMES = ['dobius.yaml'] as const

/** Absolute path to the repo's config yaml, or null if none exists. */
export function resolveRepoConfigYamlPath(repoPath: string): string | null {
  for (const name of REPO_CONFIG_YAML_NAMES) {
    const candidate = join(repoPath, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

type ProviderReadResult = { isBinary: boolean; content: string }

/**
 * Read the repo config yaml over an async fs provider (remote/SSH worktrees),
 * trying dobius.yaml. Returns the read result plus the filename that matched,
 * or null if none exists.
 */
export async function readRepoConfigYamlViaProvider(
  readFile: (path: string) => Promise<ProviderReadResult>,
  resolvePath: (name: string) => string
): Promise<(ProviderReadResult & { name: string }) | null> {
  for (const name of REPO_CONFIG_YAML_NAMES) {
    try {
      const result = await readFile(resolvePath(name))
      return { ...result, name }
    } catch {
      // Missing file — try the next candidate name.
    }
  }
  return null
}

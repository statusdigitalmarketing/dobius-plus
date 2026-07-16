import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/unused/app',
    isPackaged: false
  }
}))

import { installBundledSkill, isBundledSkillInstalled } from './local-skill-installer'

async function createSkillSource(root: string, skillName: string): Promise<string> {
  const skillDir = join(root, 'skills', skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\n---\n`)
  return skillDir
}

describe('local bundled skill installer', () => {
  it('rejects unknown and traversal skill names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dobius-local-skill-'))

    await expect(
      installBundledSkill('../dobius-cli', { appPath: root, homeDir: join(root, 'home') })
    ).rejects.toThrow('Unknown bundled skill')
    await expect(
      isBundledSkillInstalled('unknown', { homeDir: join(root, 'home') })
    ).rejects.toThrow('Unknown bundled skill')
  })

  it('copies SKILL.md into the Claude skills target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dobius-local-skill-'))
    const homeDir = join(root, 'home')
    await createSkillSource(root, 'dobius-cli')

    const result = await installBundledSkill('dobius-cli', { appPath: root, homeDir })

    expect(result).toEqual({
      installed: true,
      path: join(homeDir, '.claude', 'skills', 'dobius-cli')
    })
    await expect(readFile(join(result.path, 'SKILL.md'), 'utf8')).resolves.toContain(
      'name: dobius-cli'
    )
  })

  it('reports whether a bundled skill is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dobius-local-skill-'))
    const homeDir = join(root, 'home')
    await createSkillSource(root, 'dobius-emulator')

    await expect(isBundledSkillInstalled('dobius-emulator', { homeDir })).resolves.toBe(false)
    await installBundledSkill('dobius-emulator', { appPath: root, homeDir })
    await expect(isBundledSkillInstalled('dobius-emulator', { homeDir })).resolves.toBe(true)
  })
})

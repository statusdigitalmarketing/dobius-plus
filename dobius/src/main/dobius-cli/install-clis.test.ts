import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

const state = vi.hoisted(() => ({
  home: ''
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof Os>('node:os')
  return {
    ...actual,
    homedir: () => state.home
  }
})

describe('installDobiusClis', () => {
  beforeEach(() => {
    state.home = mkdtempSync(path.join(tmpdir(), 'dobius-cli-home-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replaces only stale legacy scripts that identify as Dobius-owned', async () => {
    const { installDobiusClis } = await import('./install-clis')
    const bin = path.join(state.home, '.local', 'bin')
    const owned = path.join(bin, 'dobius-reply')
    const userScript = path.join(bin, 'dobius-ask')
    installDobiusClis('/tmp/token')

    writeFileSync(owned, '#!/bin/bash\nTOKEN=voice-bridge-token\n', 'utf8')
    writeFileSync(userScript, '#!/bin/bash\necho user-owned\n', 'utf8')

    installDobiusClis('/tmp/token')

    expect(readFileSync(owned, 'utf8')).toContain('This Dobius+ command was retired')
    expect(readFileSync(userScript, 'utf8')).toBe('#!/bin/bash\necho user-owned\n')
    expect(readFileSync(path.join(bin, 'dobius-tabs'), 'utf8')).toContain('/tabList')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { readProviderEnv } from './provider-env'

const OLD_ENV = process.env

describe('readProviderEnv', () => {
  afterEach(() => {
    process.env = OLD_ENV
  })

  it('reads the DOBIUS provider env', () => {
    process.env = { ...OLD_ENV, DOBIUS_GITEA_TOKEN: 'new-token' }

    expect(readProviderEnv('GITEA_TOKEN')).toBe('new-token')
  })

  it('returns null when the DOBIUS provider env is blank', () => {
    process.env = { ...OLD_ENV, DOBIUS_GITEA_TOKEN: '   ' }

    expect(readProviderEnv('GITEA_TOKEN')).toBeNull()
  })
})

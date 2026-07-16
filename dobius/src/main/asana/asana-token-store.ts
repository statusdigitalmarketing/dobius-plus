import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ASANA_TOKEN_FILE = 'asana-token.enc'
let cachedAsanaToken: string | null = null

function getDobiusDir(): string {
  return join(homedir(), '.dobius')
}

function ensureDobiusDir(): void {
  const dir = getDobiusDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getAsanaTokenPath(): string {
  return join(getDobiusDir(), ASANA_TOKEN_FILE)
}

export function hasAsanaToken(): boolean {
  // Why: Settings calls this on startup; checking file existence avoids
  // decrypting safeStorage and triggering macOS keychain prompts.
  return existsSync(getAsanaTokenPath())
}

export function setAsanaToken(pat: string): void {
  const trimmed = pat.trim()
  if (!trimmed) {
    throw new Error('Asana Personal Access Token is required')
  }
  ensureDobiusDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getAsanaTokenPath(), safeStorage.encryptString(trimmed), { mode: 0o600 })
    cachedAsanaToken = trimmed
    return
  }

  console.warn('[asana] safeStorage encryption unavailable — storing Asana token in plaintext')
  writeFileSync(getAsanaTokenPath(), trimmed, { encoding: 'utf8', mode: 0o600 })
  cachedAsanaToken = trimmed
}

export function getAsanaToken(): string {
  if (cachedAsanaToken !== null) {
    return cachedAsanaToken
  }

  const tokenPath = getAsanaTokenPath()
  if (!existsSync(tokenPath)) {
    throw new Error('Asana Personal Access Token is not configured')
  }
  try {
    const raw = readFileSync(tokenPath)
    cachedAsanaToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedAsanaToken
  } catch {
    throw new Error('Asana Personal Access Token could not be decrypted')
  }
}

export function clearAsanaToken(): void {
  cachedAsanaToken = null
  rmSync(getAsanaTokenPath(), { force: true })
}

import type { FloatingPhoneMode } from '../../shared/floating-phone'

export type FloatingPhoneEntry = {
  mode: FloatingPhoneMode
  worktreeId: string | null
  url: string | null
}

export function normalizeFloatingPhoneUrlInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function isFloatingPhoneMode(value: string | null): value is FloatingPhoneMode {
  return value === 'web' || value === 'app'
}

export function parseFloatingPhoneHash(hash: string): FloatingPhoneEntry | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) {
    return null
  }
  const params = new URLSearchParams(raw)
  if (params.get('phone-visual') !== '1') {
    return null
  }
  const mode = params.get('mode')
  if (!isFloatingPhoneMode(mode)) {
    return null
  }
  const rawUrl = params.get('url')
  const url = rawUrl ? normalizeFloatingPhoneUrlInput(rawUrl) : null
  if (rawUrl && !url) {
    return null
  }
  return {
    mode,
    worktreeId: params.get('worktree') || null,
    url
  }
}

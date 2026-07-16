export type FloatingPhoneMode = 'web' | 'app'

export type FloatingPhoneWindowArgs = {
  worktreeId?: string
  mode?: FloatingPhoneMode
  url?: string
}

export type FloatingPhoneWindowResult = { ok: true; windowId: number } | { ok: false }

export type FloatingPhoneUpdate = {
  worktreeId: string | null
  mode: FloatingPhoneMode
  url: string | null
}

export type FloatingPhoneBounds = {
  x: number
  y: number
  width: number
  height: number
}

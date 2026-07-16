import { isValidTerminalTabId } from '../../shared/terminal-tab-id'

export type TornOffTerminalEntry = {
  tabId: string
  ptyId: string
  title: string
  // Origin project/worktree identity so the floating window stays aware of and
  // labeled with the project it came from. Absent for pre-existing windows.
  worktreeId: string | null
  worktreeName: string | null
}

export function parseTornOffTerminalHash(hash: string): TornOffTerminalEntry | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) {
    return null
  }
  const params = new URLSearchParams(raw)
  const tabId = params.get('terminal-tab') ?? ''
  const ptyId = params.get('pty') ?? ''
  if (!isValidTerminalTabId(tabId) || ptyId.length === 0) {
    return null
  }
  return {
    tabId,
    ptyId,
    title: params.get('title')?.trim() || 'Terminal',
    worktreeId: params.get('worktree')?.trim() || null,
    worktreeName: params.get('worktree-name')?.trim() || null
  }
}

const WSLENV_ENTRY_SEPARATOR = ':'

function parseWslenvEntries(value: string | undefined): string[] {
  return value ? value.split(WSLENV_ENTRY_SEPARATOR).filter(Boolean) : []
}

function upsertWslenvEntry(entries: string[], entry: string): void {
  const variableName = entry.split('/')[0]
  const existingIndex = entries.findIndex((value) => value.split('/')[0] === variableName)
  if (existingIndex === -1) {
    entries.push(entry)
    return
  }
  entries[existingIndex] = entry
}

export function addDobiusWslInteropEnv(env: Record<string, string>): void {
  const entries = parseWslenvEntries(env.WSLENV)
  // Why: wsl.exe only imports selected Windows env vars. Agent status in WSL
  // needs both the pane identity and the hook/OMP coordinates at process start.
  const passthroughEntries = [
    'DOBIUS_TERMINAL_HANDLE/u',
    'DOBIUS_PANE_KEY/u',
    'DOBIUS_TAB_ID/u',
    'DOBIUS_WORKTREE_ID/u',
    'DOBIUS_AGENT_LAUNCH_TOKEN/u',
    'DOBIUS_AGENT_HOOK_PORT/u',
    'DOBIUS_AGENT_HOOK_TOKEN/u',
    'DOBIUS_AGENT_HOOK_ENV/u',
    'DOBIUS_AGENT_HOOK_VERSION/u',
    'DOBIUS_AGENT_HOOK_ENDPOINT/p',
    'DOBIUS_OMP_SOURCE_AGENT_DIR/p',
    'DOBIUS_OMP_STATUS_EXTENSION/p'
  ]
  for (const entry of passthroughEntries) {
    const variableName = entry.split('/')[0]
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}

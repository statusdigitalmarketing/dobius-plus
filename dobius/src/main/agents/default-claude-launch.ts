import type { PrepareClaudeLaunch } from './agent-runner'

// Why: RPC callers (CLI `agents run`) have no IPC registration path to hand in a
// launch preparer per call, so the app registers its preparer once at boot.
let defaultPrepareClaudeLaunch: PrepareClaudeLaunch | null = null

export function setDefaultPrepareClaudeLaunch(prepare: PrepareClaudeLaunch): void {
  defaultPrepareClaudeLaunch = prepare
}

export function getDefaultPrepareClaudeLaunch(): PrepareClaudeLaunch | null {
  return defaultPrepareClaudeLaunch
}

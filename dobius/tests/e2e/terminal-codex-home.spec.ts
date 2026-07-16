import { test, expect } from './helpers/dobius-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  dobiusCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ dobiusPage }) => {
    await waitForSessionReady(dobiusPage)
    await waitForActiveWorktree(dobiusPage)
    await ensureTerminalVisible(dobiusPage)
  })

  test('terminal process receives the Dobius-managed Codex home', async ({ dobiusPage }) => {
    await waitForActiveTerminalManager(dobiusPage)
    const ptyId = await waitForActivePanePtyId(dobiusPage)
    const marker = `__DOBIUS_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, dobiusCodexHome: process.env.DOBIUS_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(dobiusPage, ptyId, command)

    let probe: CodexHomeProbe | null = null
    await expect
      .poll(
        async () => {
          probe = readCodexHomeProbe(await getTerminalContent(dobiusPage), marker)
          return Boolean(
            probe?.codexHome &&
            probe.dobiusCodexHome &&
            probe.codexHome === probe.dobiusCodexHome &&
            /[\\/]codex-runtime-home[\\/]home$/.test(probe.codexHome)
          )
        },
        { timeout: 15_000, message: 'Terminal did not expose Dobius-managed Codex home env' }
      )
      .toBe(true)

    expect(probe?.codexHome).toBe(probe?.dobiusCodexHome)
  })
})

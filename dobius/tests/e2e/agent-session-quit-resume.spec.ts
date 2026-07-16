import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, TestInfo } from '@playwright/test'
import { test, expect } from './helpers/dobius-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/dobius-restart'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

const PROVIDER_SESSION_ID = 'e2e-quit-resume-session'
const SIGTERM_PROVIDER_SESSION_ID = 'e2e-quit-resume-sigterm-session'

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

test.describe.configure({ mode: 'serial' })

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function runQuitResumeScenario(
  testInfo: TestInfo,
  opts: { signal: 'SIGKILL' | 'SIGTERM'; providerSessionId: string }
): Promise<void> {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  test.skip(process.platform === 'win32', 'Uses POSIX signals to simulate daemon death')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const page = await firstApp.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const marker = `AGENT_QUIT_RESUME_${Date.now()}`
    const descriptor = await waitForActivePaneHookDescriptor(page)
    const firstPtyId = await waitForActivePanePtyId(page)
    await execInTerminal(page, firstPtyId, `echo ${marker}`)
    await waitForTerminalOutput(page, marker)

    // Why: a real agent run reports its provider session id over the hook
    // server; seeding the same store entry keeps this test hermetic (no agent
    // CLI install or auth) while exercising the identical persistence path.
    await page.evaluate(
      ({ paneKey, worktreeId: wtId, providerSessionId }) => {
        window.__store
          ?.getState()
          .setAgentStatus(
            paneKey,
            { state: 'working', prompt: 'finish the task', agentType: 'codex' },
            'Codex',
            undefined,
            { worktreeId: wtId },
            { providerSession: { key: 'session_id', id: providerSessionId } }
          )
      },
      {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        providerSessionId: opts.providerSessionId
      }
    )

    const daemonPid = readDaemonPid(session.userDataDir)

    await session.close(firstApp)
    firstApp = null

    // Why: simulates the daemon (and the agent CLI inside it) dying while the
    // app is closed. SIGKILL covers reboot/crash; SIGTERM covers updaters and
    // install scripts — the daemon's graceful signal shutdown must also leave
    // history restorable so the relaunch takes the cold-restore path.
    process.kill(daemonPid, opts.signal)
    if (opts.signal === 'SIGTERM') {
      // Why: graceful shutdown checkpoints sessions before exiting; relaunching
      // mid-teardown would race the new daemon against the dying one.
      await waitForProcessExit(daemonPid, 15_000)
    }

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(
        async () => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId),
        { timeout: 15_000 }
      )
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await waitForActiveTerminalManager(secondLaunch.page, 30_000)
    await waitForPaneCount(secondLaunch.page, 1, 30_000)

    // The quit-captured provider session id must drive a resume command into
    // the cold-restored pane (the command text echoes in the terminal).
    await waitForTerminalOutput(secondLaunch.page, opts.providerSessionId, 30_000)

    // No duplicate resume tab: the quit-origin record must not be consumed by
    // worktree activation on top of the pane-level cold-restore.
    const terminalTabCount = await secondLaunch.page.evaluate(
      (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? []).length,
      worktreeId
    )
    expect(terminalTabCount).toBe(1)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
}

test('resumes an agent session after quit when its daemon PTY died while the app was closed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  await runQuitResumeScenario(testInfo, {
    signal: 'SIGKILL',
    providerSessionId: PROVIDER_SESSION_ID
  })
})

test('resumes an agent session after the daemon was SIGTERMed while the app was closed (updater/install-script kill)', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  await runQuitResumeScenario(testInfo, {
    signal: 'SIGTERM',
    providerSessionId: SIGTERM_PROVIDER_SESSION_ID
  })
})

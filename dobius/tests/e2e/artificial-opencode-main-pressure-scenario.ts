import type { Page, TestInfo } from '@playwright/test'
import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { sendToTerminal } from './helpers/terminal'
import { writePressureOutputScript } from './artificial-opencode-hidden-pressure-scenario'
import {
  annotateScrollMeasurement,
  getResponsiveScrollPath,
  measureActiveTerminalWheelScroll,
  scrollActiveTerminalToBottom,
  seedActiveTerminalScrollback
} from './artificial-opencode-scroll-scenario'

type MainPressurePane = {
  paneKey: string
  ptyId: string
}

type MainPressureMeasurement = {
  medianLatencyMs: number
  worstLatencyMs: number
  maxTimerDriftMs: number
}

type MainPressureSnapshot = {
  peakPendingChars: number
  peakRendererInFlightChars: number
  ackGatedFlushSkipCount: number
}

type MainPressureAckGate = {
  heldAckChars: number
}

type MainPressureSchedulerSnapshot = {
  peakQueuedChars: number
  droppedBacklogCount: number
}

// Why: peak queued chars is noisy at the byte level on CI, but a coarse cap
// still catches renderer queue growth that dropped-backlog/latency checks miss.
const MAX_RENDERER_SCHEDULER_QUEUED_CHARS = 5 * 1024 * 1024

type MainPressureDeps<
  TMeasurement,
  TDebug,
  TScheduler extends MainPressureSchedulerSnapshot,
  TMainPressure,
  TAckGate
> = {
  annotateTypingMeasurement: (
    testInfo: TestInfo,
    type: string,
    paneCount: number,
    measurement: TMeasurement,
    debug: TDebug | null,
    scheduler: TScheduler | null,
    mainPressure: TMainPressure | null,
    ackGate: TAckGate | null
  ) => void
  ensureActiveWorktreePaneLoad: (page: Page, paneCount: number) => Promise<MainPressurePane[]>
  focusPane: (page: Page, paneKey: string) => Promise<void>
  holdTerminalAckGate: (page: Page, ptyIds: string[]) => Promise<void>
  measureTypingDuringLoad: (
    page: Page,
    scriptPath: string,
    ptyId: string,
    runId: string
  ) => Promise<TMeasurement>
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
  readTerminalAckGateDebug: (page: Page) => Promise<TAckGate | null>
  readTerminalOutputSchedulerDebug: (page: Page) => Promise<TScheduler | null>
  readTerminalPtyOutputDebug: (page: Page) => Promise<TDebug | null>
  releaseTerminalAckGate: (page: Page) => Promise<void>
  resetTerminalPtyOutputDebug: (page: Page) => Promise<void>
  waitForActiveWorktree: (page: Page) => Promise<string>
  waitForMainPtyPressureBacklog: (page: Page) => Promise<TMainPressure>
  waitForSessionReady: (page: Page) => Promise<void>
  writeInteractivePromptScript: (scriptPath: string, runId: string) => void
}

export async function runMainPressureScenario<
  TMeasurement extends MainPressureMeasurement,
  TMainPressure extends MainPressureSnapshot,
  TAckGate extends MainPressureAckGate,
  TDebug,
  TScheduler extends MainPressureSchedulerSnapshot
>({
  annotationSuffix,
  backgroundPaneCount,
  deps,
  maxMedianKeyLatencyMs,
  maxScrollLatencyMs,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  pressureOutputChars,
  testInfo,
  testRepoPath,
  dobiusPage
}: {
  annotationSuffix: string
  backgroundPaneCount: number
  deps: MainPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  maxMedianKeyLatencyMs: number
  maxScrollLatencyMs: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  pressureOutputChars: number
  testInfo: TestInfo
  testRepoPath: string
  dobiusPage: Page
}): Promise<void> {
  await deps.waitForSessionReady(dobiusPage)
  await deps.waitForActiveWorktree(dobiusPage)
  const panes = await deps.ensureActiveWorktreePaneLoad(dobiusPage, backgroundPaneCount + 1)
  const [typingPane, ...loadPanes] = panes
  await deps.focusPane(dobiusPage, typingPane.paneKey)

  const runId = randomUUID()
  const scrollRunId = randomUUID()
  const typingScriptPath = path.join(testRepoPath, `.dobius-opencode-pressure-typing-${runId}.mjs`)
  const pressureScriptPath = path.join(testRepoPath, `.dobius-opencode-pressure-load-${runId}.mjs`)
  await seedActiveTerminalScrollback(dobiusPage, typingPane.ptyId, scrollRunId)
  deps.writeInteractivePromptScript(typingScriptPath, runId)
  writePressureOutputScript(pressureScriptPath, runId)
  await deps.resetTerminalPtyOutputDebug(dobiusPage)
  await deps.holdTerminalAckGate(
    dobiusPage,
    loadPanes.map((pane) => pane.ptyId)
  )
  try {
    await startPressureCommands({
      loadPanes,
      dobiusPage,
      pressureOutputChars,
      pressureScriptPath
    })
    const pressureBeforeTyping = await deps.waitForMainPtyPressureBacklog(dobiusPage)
    await measureAndAnnotateScroll({
      annotationSuffix,
      deps,
      maxScrollLatencyMs,
      maxTimerDriftMs,
      dobiusPage,
      panes,
      testInfo
    })
    const measurement = await deps.measureTypingDuringLoad(
      dobiusPage,
      typingScriptPath,
      typingPane.ptyId,
      runId
    )
    const mainPressure = await deps.readMainPtyPressureDebug(dobiusPage)
    const ackGate = await deps.readTerminalAckGateDebug(dobiusPage)
    const scheduler = await deps.readTerminalOutputSchedulerDebug(dobiusPage)
    deps.annotateTypingMeasurement(
      testInfo,
      `opencode-main-pressure-active-typing${annotationSuffix}`,
      panes.length,
      measurement,
      await deps.readTerminalPtyOutputDebug(dobiusPage),
      scheduler,
      mainPressure,
      ackGate
    )
    expectMainPressureAndTyping({
      ackGate,
      mainPressure,
      maxMedianKeyLatencyMs,
      maxTimerDriftMs,
      maxWorstKeyLatencyMs,
      measurement,
      pressureBeforeTyping,
      scheduler
    })
  } finally {
    await deps.releaseTerminalAckGate(dobiusPage)
    await sendToTerminal(dobiusPage, typingPane.ptyId, '\x03').catch(() => undefined)
    await Promise.all(
      loadPanes.map((pane) => sendToTerminal(dobiusPage, pane.ptyId, '\x03').catch(() => undefined))
    )
    rmSync(typingScriptPath, { force: true })
    rmSync(pressureScriptPath, { force: true })
  }
}

async function startPressureCommands({
  loadPanes,
  dobiusPage,
  pressureOutputChars,
  pressureScriptPath
}: {
  loadPanes: MainPressurePane[]
  dobiusPage: Page
  pressureOutputChars: number
  pressureScriptPath: string
}): Promise<void> {
  await Promise.all(
    loadPanes.map((pane, paneIndex) =>
      sendToTerminal(
        dobiusPage,
        pane.ptyId,
        `node ${JSON.stringify(pressureScriptPath)} ${paneIndex} ${pressureOutputChars}\r`
      )
    )
  )
}

async function measureAndAnnotateScroll<
  TMeasurement,
  TDebug,
  TScheduler extends MainPressureSchedulerSnapshot,
  TMainPressure,
  TAckGate
>({
  annotationSuffix,
  deps,
  maxScrollLatencyMs,
  maxTimerDriftMs,
  dobiusPage,
  panes,
  testInfo
}: {
  annotationSuffix: string
  deps: MainPressureDeps<TMeasurement, TDebug, TScheduler, TMainPressure, TAckGate>
  maxScrollLatencyMs: number
  maxTimerDriftMs: number
  dobiusPage: Page
  panes: MainPressurePane[]
  testInfo: TestInfo
}): Promise<void> {
  const scrollMeasurement = await measureActiveTerminalWheelScroll(dobiusPage)
  const mainPressureAfterScroll = await deps.readMainPtyPressureDebug(dobiusPage)
  const ackGateAfterScroll = await deps.readTerminalAckGateDebug(dobiusPage)
  annotateScrollMeasurement(
    testInfo,
    `opencode-main-pressure-active-scroll${annotationSuffix}`,
    panes.length,
    scrollMeasurement,
    mainPressureAfterScroll,
    ackGateAfterScroll
  )
  const responsivePath = getResponsiveScrollPath(scrollMeasurement)
  if (responsivePath) {
    expect(responsivePath.latencyMs).toBeLessThan(maxScrollLatencyMs)
  }
  expect(scrollMeasurement.maxTimerDriftMs).toBeLessThan(maxTimerDriftMs)
  await scrollActiveTerminalToBottom(dobiusPage)
}

function expectMainPressureAndTyping<TMeasurement extends MainPressureMeasurement>({
  ackGate,
  mainPressure,
  maxMedianKeyLatencyMs,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  measurement,
  pressureBeforeTyping,
  scheduler
}: {
  ackGate: MainPressureAckGate | null
  mainPressure: MainPressureSnapshot | null
  maxMedianKeyLatencyMs: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  measurement: TMeasurement
  pressureBeforeTyping: MainPressureSnapshot
  scheduler: MainPressureSchedulerSnapshot | null
}): void {
  expect(pressureBeforeTyping.peakPendingChars).toBeGreaterThan(0)
  expect(pressureBeforeTyping.ackGatedFlushSkipCount).toBeGreaterThan(0)
  expect(mainPressure?.peakRendererInFlightChars ?? 0).toBeGreaterThanOrEqual(8 * 1024 * 1024)
  expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
  expect(scheduler?.droppedBacklogCount ?? Number.POSITIVE_INFINITY).toBe(0)
  expect(scheduler?.peakQueuedChars ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    MAX_RENDERER_SCHEDULER_QUEUED_CHARS
  )
  expect(measurement.medianLatencyMs).toBeLessThan(maxMedianKeyLatencyMs)
  expect(measurement.worstLatencyMs).toBeLessThan(maxWorstKeyLatencyMs)
  expect(measurement.maxTimerDriftMs).toBeLessThan(maxTimerDriftMs)
}

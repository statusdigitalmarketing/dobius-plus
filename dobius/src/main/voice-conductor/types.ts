// Shared contract for the Voice Conductor port (v1 electron/ → v2 dobius/).
// Every conductor module — engine, dispatch CLIs, work registry, iMessage
// bridge, Asana queue — codes against these types so the parallel
// implementations integrate without inventing conflicting interfaces.
//
// Ownership boundary: leaf modules (WorkRegistry / IMessageBridge / AsanaQueue)
// are self-contained new files. The engine runs the background Claude session
// and is fed transcripts. The dispatch CLIs (Phase 2) call the leaf modules.

export type VoiceConductorStatus = {
  enabled: boolean
  running: boolean
  runId: string | null
  sessionId: string | null
  lastError: string | null
}

/**
 * Phase 1 — the engine. A long-running background Opus Claude session (via the
 * SDK agent-runner, no window/tab) that ingests transcripts and dispatches work.
 */
export type VoiceConductor = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  getStatus(): VoiceConductorStatus
  /**
   * Feed a voice/text transcript to the running session. Resumes the SAME
   * Claude session so context carries across turns (the v2 analog of writing
   * to the v1 conductor PTY's stdin). `requestId` tags the turn so the reply
   * can be routed back via getReply.
   */
  postTranscript(input: { transcript: string; requestId: string }): Promise<void>
  /** The conductor's one-line spoken reply for a turn, set by the dobius-reply CLI. */
  setReply(requestId: string, message: string): void
  /** Read a reply newer than `sinceTs` (ms). Null if none yet — callers poll. */
  getReply(requestId: string, sinceTs?: number): { message: string; ts: number } | null
}

/** Phase 3 — work registry: track dispatched jobs, notify on completion. */
export type WorkItem = {
  workId: string
  tabId: string
  requestId: string
  description: string
  startedAt: number
  status: 'running' | 'done' | 'error'
  summary?: string
}

export type WorkRegistry = {
  track(item: Pick<WorkItem, 'workId' | 'tabId' | 'requestId' | 'description'>): void
  /** Snapshot, optionally filtered by a fuzzy target (workId/tabId/description substring). */
  status(target?: string): WorkItem[]
  markDone(workId: string, summary: string, status?: 'done' | 'error'): WorkItem | null
  list(): WorkItem[]
}

/** Phase 5 — iMessage bridge (macOS only, AppleScript). */
export type IMessageBridge = {
  /** False on non-macOS or when Messages automation is unavailable. */
  isAvailable(): boolean
  send(text: string): Promise<void>
  /** Send a question and block for the user's reply, bounded by timeoutMs (default 5 min). */
  ask(question: string, timeoutMs?: number): Promise<string>
}

/** Phase 6 — Asana queue. Lane mirrors the workspace rules (build = Carson, review = Sam). */
export type AsanaLane = 'build' | 'review'

export type AsanaQueueTask = {
  gid: string
  title: string
  notes: string
  lane: AsanaLane
}

export type AsanaQueue = {
  fetch(queue: string): Promise<{ tasks: AsanaQueueTask[]; summary: string }>
}

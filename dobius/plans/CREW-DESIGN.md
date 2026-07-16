# Dobius+ Crew — Design Doc (research-backed)

Persistent, proactive agents living in the Agents tab. Synthesis of three research passes
(2026-07-07): OpenClaw deep-dive, mission-control UI survey, assistant-platform + Agent SDK
ground truth. Full reports in session transcript; key citations inline.

## Thesis

OpenClaw proved the magic is exactly four primitives: **chat-channel ingress, markdown memory
injected per turn, a heartbeat with a silent-OK sentinel, and cron/webhook triggers**. It died
(as an enterprise-viable thing) on: exposed gateways, an unmoderated skill registry (~36%
prompt-injection rate), memory poisoning from background turns, and approvals that were
advisory. Dobius+ can ship the four primitives inside a local desktop app with none of those
wounds — and it owns things OpenClaw had to bolt on: an iMessage bridge, Asana lanes,
instrumented terminals, worktrees, and the Agent SDK.

**The market gap (verified)**: nobody ships a real automatic notify-vs-silent judgment layer
except Poke (undocumented, reverse-engineered). Everyone else = user-authored rules + digests.
The SDK's `outputFormat` (json_schema, validated, re-prompted on mismatch) is precisely the
primitive to build one. That's our headline feature.

**The UI lesson (verified)**: Terragon (cloud status dashboard) is dead; Conductor (local +
review-first) won. Agents produce faster than humans review, so the page's job is a
**decision queue, not a status wall**.

## Architecture (all primitives verified against sdk.d.ts v0.3.201)

### 1. Identity & memory — "crew members", not saved prompts
- Agent record grows: `emoji/avatar`, `persona` (SOUL-style, folded into systemPrompt),
  `schedule`, `channels`, `notifyBudget`.
- **Memory**: per-agent memory dir via `AgentDefinition.memory: 'user'` →
  `~/.claude/agent-memory/<agentType>/` (SDK auto-loads). Plus the Anthropic long-running-agent
  pattern: a `progress-log.md` each run reads at start / appends at end. Plain markdown =
  inspectable, hand-editable, diffable (the #1 anti-"it forgot" mitigation in the market).
- **Sessions**: store `lastSessionId` per agent; `resume` for continuity, `forkSession` for
  branches. Gotchas handled: resume is cwd-keyed (always run an agent in its configured cwd);
  transcripts auto-clean after `cleanupPeriodDays` (default 30) — memory files, not transcripts,
  are the durable layer.
- **Memory-poisoning guard** (OpenClaw lesson, arXiv 2603.23064): scheduled/channel-triggered
  runs get memory-dir writes **denied via PreToolUse hook** (hooks hold even in
  bypassPermissions). Memory writes are allowed only in user-initiated runs, or land as a
  proposed diff in the decision queue.

### 2. Heartbeats + the judgment layer (the differentiator)
- Per-agent schedule (reuse AutomationService tick engine; per-agent interval + activeHours).
- Heartbeat run recipe: `permissionMode: 'dontAsk'` + explicit `allowedTools` (unlisted = hard
  deny, no hangs), `maxTurns`, `maxBudgetUsd`, and
  `outputFormat: { type: 'json_schema', schema: { important, urgency: 'now'|'digest'|'silent',
  summary, actions_taken } }` — validated by the SDK, retried on mismatch,
  `error_max_structured_output_retries` handled.
- Routing: `silent` → logged only. `digest` → batched into a morning briefing. `now` → macOS
  notification + optional iMessage/Telegram.
- **Hard attention budget**: max 3–5 `now` pings/day across the whole crew (research: users'
  real budget; dismissed notifications are worse than none). Enforced in code, not prompt.
  Overflow demotes to digest.

### 3. Decision queue (approval inbox)
- Attended/interactive runs use `canUseTool` → each request becomes an inbox row on the Agents
  page: **the exact command/diff/recipient** (never a paraphrase) + Approve / Edit args /
  Respond / Deny. `suggestions → updatedPermissions` implements "always allow" (learned
  auto-approvals — the anti-fatigue mechanism).
- **Hard rails live in PreToolUse hooks**, not the queue (evaluation order: hooks run first and
  bind even under bypassPermissions): no force-push, no credential-file reads, no rm -rf, no
  memory writes from untrusted runs, no outbound messages except via the channel layer.
- Badge count + "waiting on you" is the loudest state in the UI; question answerable in place.

### 4. Channels (iMessage first — the party trick)
- Inbound: iMessage bridge (already in app) routes "@AgentName ..." texts → agent run; reply
  returns to Messages. Telegram second.
- **Lethal-trifecta guard** (the core OpenClaw lesson): channel-triggered runs are treated as
  untrusted input → read-only default toolset, no memory writes, outbound replies only to the
  originating thread, hard rails on. Full capability requires the user to re-run from the app.
- Outbound: draft-first for anything user-visible beyond the reply itself.

### 5. Mission control (the board)
- **Triage list first**: rows = every live agent from every source (SDK runs; terminal agents
  via the agent-hooks pipeline that already drives status dots). Status, current tool, elapsed,
  last message snippet. "Waiting on you" rows show the actual question inline, reply-in-place.
- Per-run drill-in: waterfall timeline + chat-rendered transcript (the two visualizations that
  survive daily use per the observability survey). Cost/turns on the run summary line.
- Daily rollup: spend, runs, success rate, cost-per-successful-task. No live-list cost
  (Claude Code Agent View precedent: triage beats accounting).
- Later: artifacts panel + comment-to-steer (Antigravity's pattern), attempts/multi-model
  compare (Vibe Kanban).

## Phases (each = one codex stage + review + install + live test)
1. **Crew v1 — identity, memory, sessions**: emoji/persona fields, per-agent memory dir +
   progress log, session resume, memory viewer/editor in the UI ("what does this agent know").
2. **Heartbeats + judgment layer**: schedules, structured heartbeat output, silent/digest/now
   routing, attention budget, morning briefing view, macOS notifications.
3. **Decision queue**: canUseTool inbox + PreToolUse hard rails + learned auto-approvals.
4. **iMessage channel**: text your crew; trifecta guards.
5. **Mission control board**: unified triage list (SDK + terminal agents), drill-in waterfall,
   daily rollup.

## Explicitly rejected (learned from research)
- No public gateway / no remote-network listener — everything stays loopback/in-app.
- No open skill registry — skills come only from ~/.claude/skills (user-owned).
- No prompt-only guardrails for safety-critical rules — hooks/allowlists only.
- No unbounded heartbeats — every scheduled run carries maxTurns + maxBudgetUsd.
- No cost surface on the live list; no force-directed graph views; no enterprise dashboard sprawl.

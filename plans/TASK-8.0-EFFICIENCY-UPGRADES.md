# TASK-8.0 — Efficiency Upgrades (Epic plan, design only)

**Status:** PLAN ONLY — no code written yet. Awaiting approval per phase.
**Author:** Claude (Opus 4.8)
**Created:** 2026-06-14
**Canonical checkout:** `/Users/bayou/Projects (Code)/dobius-plus` (branch `feature/bugfix-data`)
**Depends on:** Epic 7 (Kanban pipeline) for stage/event data. Tasks below note whether they need 7.x first.

---

## Review corrections (Opus architect pass, 2026-06-14) — these OVERRIDE the task bodies below

Three "leans on existing X" claims are FALSE and change scope, not just wording:

1. **8.1 Telegram has NO send path in the app.** Telegram is MCP-only (callable by Claude in a session, not by Electron main). No Telegram code exists in `electron/` or `src/`; the chatId appears nowhere in the tree. **8.1 requires a NEW direct Bot-API sender** — `electron/notify-telegram.js` doing a raw `https.request` to `api.telegram.org/bot<token>/sendMessage`, copying the `asanaGet` pattern in `asana-queue.js`. Token from config, never code.
2. **8.3 cost has NO per-session granularity.** `Costs.jsx` → `loadProjectTokens()` (data-service.js:805) aggregates all session JSONLs into ONE per-project total and discards sessionId. There is no per-session cost to join to a task. **8.3 requires a NEW per-session cost rollup** (modify `loadProjectTokens` to emit rows keyed by sessionId) as its own sub-task before the card footer. The §3 "don't invent a second path" note is moot — there is no first path at session grain.
3. **8.2 evidence: both primitives are unusable as-is.** `visual:screenshot` (main.js:695) needs a `webContentsId` passed FROM the renderer and captures the Visual phone-preview, not the work; it has no main entry. `git:diff` (main.js:1088 → `getCommitDiff`) needs a commit hash, but at `shiptest` the work is often uncommitted. **8.2 needs a NEW main-callable screenshot route AND a working-tree-diff variant.** Re-scope as net-new.
4. **8.7 scheduler ALREADY EXISTS and runs.** `electron/scheduled-tasks.js` is a complete cron (60s tick, daily/interval/business-hours, 3 seeded defaults, `/scheduled/list|update` bridge routes). `config.scheduledTasks` is NOT empty — it seeds on first run. **Re-scope 8.7 down to: a Settings UI over the existing scheduler + add Telegram as an output channel alongside iMessage.**
5. **8.6 Cmd+K collides** with the existing "clear terminal" binding (root CLAUDE.md). Pick a different chord or scope the palette to dashboard view.
6. **8.8 `maxConcurrentAgents` defaults to `1`** (serial) and `maxPerProject:1` also gates it (work-registry.js). The "3 of 5 slots" UI implies raising both — call that out.

Net: fix 8.1 / 8.2 / 8.3 scope (all net-new, not thin wrappers) and re-scope 8.7 before building.

---

## 0. Theme

Epic 7 makes the work *visible* (tasks flow through stages on a board). Epic 8 makes the work *come to you* — the app reports to you and stops where a human is genuinely required, instead of you babysitting terminals. Every item leans on something Dobius+ or Hermes already has, so none is a moonshot.

Borrowed-from-Hermes ideas, mapped to Dobius+ assets:
- Hermes per-session token + USD cost tracking → cost per task.
- Hermes `task_runs` + circuit breaker (`consecutive_failures >= max_retries`) → "gave up, here's why" instead of infinite loops.
- Hermes platform-agnostic delivery (Telegram/Slack/SMS) → push the user at the approval gate only.
- Hermes idempotent webhook intake → instant Asana intake.
- Hermes cron routines → recurring standing jobs.

---

## 1. Tasks (prioritized: 8.1-8.4 are the "stop babysitting" wins; 8.5-8.8 are speed/polish)

### 8.1 — Telegram approval pings (HIGHEST VALUE)
**What:** When a task reaches `approval` (Epic 7) — both gates passed, waiting on the human — send one Telegram message: "Task '<title>' passed review + ship-test. Approve? <deep-link>". Optionally a digest when a task enters `blocked`.
**Why:** The single biggest behavior change — you walk away and get pinged once, only when a decision is required.
**Leans on:** existing Telegram target (`@AsanaNotiBot`, send-only MCP, chatId on file); Epic 7 stage transitions as the trigger.
**Needs:** 7.1-7.4 (stage machine + transitions) first.
**New code:** `electron/notify-telegram.js` (thin send wrapper), a hook in the `approval`/`blocked` transition. Config: `config.notifications = { telegram: { enabled, onApproval: true, onBlocked: true, chatId } }`.
**Verify:** drive a task to `approval`, confirm exactly one message arrives; disabling stops it. No secrets in code (token via config/env, per safety rules).
**Safety:** notification only — never an action. Approving still happens in-app by a human.

### 8.2 — Auto-evidence (screenshot + diff pinned to the task)
**What:** On entering `shiptest`, auto-open a fresh Visual window, screenshot the rendered result, and attach the path + the `git diff` summary to the task card. Card's `review`/`approval` view shows "here's what changed + here's how it looks".
**Why:** Your own rule: "a screenshot is the proof." Today it's manual; make it automatic and attached so approval is a glance, not a hunt.
**Leans on:** `visual:openWindow`/`visual:screenshot` IPC, `git:diff`, the "fresh window per capture" rule (SKILLS-HOOKS-AGENTS).
**Needs:** 7.1-7.5 (cards + stages).
**New code:** an evidence step in the `shiptest` transition that calls `visual:screenshot` (fresh window) + `git:diff`, stores `{ screenshotPath, diffStat }` on the task; card UI to show them.
**Verify:** run a build-lane task; confirm screenshot + diff appear on the card automatically.

### 8.3 — Cost per task + budget guardrail
**What:** Show "$X.XX · N min" on each card. Add an optional per-task budget; if a crack_bot run exceeds it, the task goes `blocked` with reason "over budget" instead of burning more.
**Why:** Visibility + a hard stop on runaway spend.
**Leans on:** existing Costs tab / cost tracking (`src/components/Dashboard/Costs.jsx`), Epic 7 `runs[]` + `stagedAt` timestamps for duration.
**Needs:** 7.1-7.2; reuse whatever cost source the Costs tab already reads.
**New code:** attribute session cost to the task via `sessionId`; card footer; `config` budget default + per-task override; budget check in the build loop.
**Verify:** a task shows real cost after a run; a tiny budget triggers a `blocked` "over budget".

### 8.4 — Circuit breaker + "why it's stuck"
**What:** Port Hermes's breaker: after N consecutive failed attempts (`runs[]` outcome `failed`), auto-`block` the task as "gave up" with the last error excerpt on the card, instead of the supervisor re-looping forever.
**Why:** You see *why* something stalled and stop wasting runs.
**Leans on:** crack_bot supervisor (the loop), Epic 7 `runs[]` + `blocked` stage.
**Needs:** 7.1-7.4.
**New code:** `consecutiveFailures` counter on the task; check in the supervisor-resume path; card shows last error.
**Verify:** force a task to fail N times; confirm it blocks as "gave up" with the error, and stops retrying.

### 8.5 — Asana webhooks (instant intake)
**What:** Replace the 10-min poll with an Asana webhook so new tasks appear in `intake` within seconds. Keep idempotent create (keyed on `asanaGid`) so duplicate deliveries are safe.
**Why:** Faster intake, no wasted polling.
**Leans on:** `electron/asana-queue.js`, `auto-mode.js`; Hermes idempotency pattern (already adopted in 7.3).
**Needs:** 7.3.
**New code:** a small local webhook receiver (Express, already a dep) + Asana webhook registration; fall back to polling if the webhook is down.
**Verify:** create an Asana task; card appears in seconds; double-delivery makes one card.
**Risk:** needs a reachable URL for Asana → use a tunnel or keep poll as fallback; decide at build.

### 8.6 — Command palette (Cmd+K)
**What:** Fuzzy switcher to jump to any project, task card, or terminal session/tab.
**Why:** Biggest "feels pro" speed win for an app with this many tabs/projects.
**Leans on:** existing project list, `terminalTabs`, `sessionTabMap`, Zustand store. No Hermes dependency.
**Needs:** nothing (independent of Epic 7; richer once cards exist).
**New code:** `src/components/shared/CommandPalette.jsx` + a Cmd+K keybinding; index projects/tabs/sessions/cards.
**Verify:** Cmd+K, type, Enter → lands on the right project/tab/session.

### 8.7 — Recurring routines
**What:** Light up `config.scheduledTasks` (currently empty): e.g. "every morning 08:00, run ship-test against prod and Telegram me the result."
**Why:** Standing health checks / chores run themselves.
**Leans on:** Hermes cron model; existing `scheduledTasks` config slot; 8.1 Telegram delivery.
**Needs:** 8.1 for delivery.
**New code:** a scheduler in main (node cron-ish), a small Settings UI to define jobs.
**Verify:** a 1-minute test job fires and delivers.

### 8.8 — Parallel dispatch from the board
**What:** Board shows "3 of 5 agent slots busy" (`workRegistry.limits.maxConcurrentAgents`); drag a `queued` card to launch it in its own worktree.
**Why:** Run multiple tasks at once without collisions.
**Leans on:** existing `workRegistry` limits + worktree concept; Hermes claim-lock idea (lite — no headless workers, just slot accounting).
**Needs:** 7.1-7.5.
**New code:** slot counter UI; launch-in-worktree action wired to a new terminal tab on a worktree branch.
**Verify:** launch 2 tasks; both build in separate worktrees; slot count reflects it.

---

## 2. Suggested sequencing

1. Epic 7 first (7.1 → 7.6) — the data + board everything else hangs on.
2. Then 8.1 (Telegram pings) + 8.2 (auto-evidence) + 8.4 (circuit breaker) — the "stop babysitting" trio, all small once 7.x exists.
3. Then 8.3 (cost/budget), 8.5 (webhooks), 8.6 (Cmd+K, can slot in anytime).
4. Later: 8.7 (routines), 8.8 (parallel dispatch).

## 3. Risks (epic-wide)

- **Secrets:** Telegram token / Asana PAT stay in config/env, never in code (safety rule). 8.1/8.5 must read from config.
- **Notification spam:** gate pings to `approval`/`blocked` only; make each toggle-able (8.1 config).
- **Webhook reachability (8.5):** keep polling as fallback.
- **Cost source accuracy (8.3):** reuse the existing Costs tab's source; don't invent a second accounting path.
- **Scope discipline:** each task is its own `TASK-8.N.md` + full gate. Do not batch.

## 4. Out of scope (this epic)

Headless background workers + real claim-lock/heartbeat; goal-mode/Ralph judge loop; multi-board SQLite migration; Slack/Discord/SMS delivery (Telegram only for now). All are later epics.

## 5. Open decisions (before building any 8.x)

1. 8.1: ping on `blocked` too, or `approval` only? (Rec: both, toggle-able.)
2. 8.5: webhook now, or keep the 10-min poll and defer webhooks? (Rec: defer — poll is fine until intake latency actually bothers you.)
3. 8.6: Cmd+K scope — projects+tabs only, or also task cards + sessions? (Rec: all four.)

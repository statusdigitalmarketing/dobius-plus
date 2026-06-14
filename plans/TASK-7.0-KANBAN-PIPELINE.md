# TASK-7.0 — Pipeline Kanban Dashboard (Epic plan, design only)

**Status:** PLAN ONLY — no code written yet. Awaiting approval to proceed.
**Author:** Claude (Opus 4.8)
**Created:** 2026-06-14
**Canonical checkout:** `/Users/bayou/Projects (Code)/dobius-plus` (branch `feature/bugfix-data`)

---

## 0. Why this exists (the one finding)

**Dobius+ runs its pipeline as prose. Hermes runs its pipeline as data.**

Today a Dobius+ task is (`electron/tasks-service.js` lines ~56-79):

```js
{ id, title, done: false, source, lane, assignee, asanaGid, dueOn, createdAt }
```

`done` is the entire lifecycle. The real pipeline — build → review-audit → ship-test → approve → done — exists **only as instructions written into the Conductor terminal** (`electron/auto-mode.js` ~line 137 writes "build FULL-AUTO via crack_bot, then review-audit, then ship-test" as text into a PTY). The work happens, but as scrolling terminal text. The dashboard has no data model of it, so it can render nothing but a checkbox. **That is why the dashboard is underused.**

Hermes (`~/.hermes/hermes-agent/hermes_cli/kanban_db.py`) does the opposite: a task is a SQLite row with an 8-state machine (`triage→todo→ready→running→blocked→review→done→archived`), an append-only `task_events` log, a `task_runs` attempt history, and a `session_id` linking the card to the live agent session. Because state is **data**, the board renders it, moves it, and animates it.

This epic ports that idea — not Hermes's generic states, but a state machine shaped to **your** Done Bar — and points the dashboard at the work that is already happening.

---

## 1. Goal

Asana task lands in **Intake** automatically → you watch it slide right through **Building → Review/Audit → Ship-Test** as the agents actually clear each gate → it parks in **Awaiting Approval** for you → you approve → **Done**. Every transition recorded. The dashboard becomes the thing you run the shop from.

Non-goal: rewriting anything. Every primitive needed already exists (IPC `tasks:*`, per-project JSON persistence, Asana sync, Zustand store, Framer Motion). This epic adds a `stage` field, an event emit at each gate, and one dashboard tab.

---

## 2. Current-state facts (verified, with anchors)

| Concern | Where it lives today |
|---|---|
| Task data shape | `electron/tasks-service.js` ~56-79 (`addTask`) |
| Task persistence | `~/.claude/project-tasks/<encoded-project>.json` |
| Task IPC | `electron/main.js` ~665-669 (`tasks:list/add/update/delete/syncAsana`) |
| Asana fetch | `electron/asana-queue.js` `fetchNewTasks()` ~132 |
| Auto-mode intake | `electron/auto-mode.js` (~10-min poll, `seen[]` dedup, writes to Conductor) |
| `dobius-task-done` | `electron/tasks-service.js` `completeTaskByRef()` ~120; fires `tasks:updated` |
| Existing "Board" tab | `src/components/Dashboard/Board/BoardView.jsx` — renders **agents**, not tasks |
| Dashboard tabs list | `src/components/Dashboard/DashboardView.jsx` ~25-67 |
| Store | `src/store/store.js` (Zustand; has `boardNotification`, `activityTimeline`) |
| Session↔tab link | `config.sessionTabMap[sessionId] = { tabId, projectPath }` |
| Git/worktree poll | `src/components/Project/ProjectView.jsx` ~65-98 (every 20s) |
| Theme/lane colors | build = `#58A6FF` (blue), review = `#A371F7` (purple) |

Key reusable asset: the existing Board tab already renders a live running-agent feed + activity timeline + completion notifications. The live-board muscle exists; it is aimed at agents instead of tasks.

---

## 3. Target state machine (shaped to the Done Bar, not Hermes's generic 8)

```
 intake → queued → building → review → shiptest → approval → done
                       │          │         │
                       └──────────┴─────────┴────────→ blocked ──(unblock)──→ (prior stage)
```

| Stage | Meaning | Entered by |
|---|---|---|
| `intake` | Just arrived (Asana auto-mode or manual add) | auto-mode / manual |
| `queued` | Accepted, not yet started | manual or auto when a worker is free |
| `building` | crack_bot/crack_repair supervisor running (build lane only; review lane skips to `review`) | supervisor start signal |
| `review` | `review-audit` skill running | skill start |
| `shiptest` | `ship-test` skill running | skill start |
| `approval` | All gates passed — **STOPS HERE for human** | both gates pass |
| `done` | Human approved + `dobius-task-done` | human action |
| `blocked` | Gate failed or manual halt; carries a reason | failure / manual |

**Safety rule made visible:** `approval` is a real column and a hard stop. The machine never auto-advances `approval → done`, never auto-closes Asana, never auto-pushes/deploys (mirrors `~/.claude/CLAUDE.md` safety rules). Done is always a human click.

`blocked` is derived/loggable like Hermes: store the reason as an event so history explains every state.

---

## 4. Data model change (additive, backward-compatible)

Extend the task shape in `electron/tasks-service.js`. Old tasks with only `done` still load (migration: `done:true ⇒ stage:'done'`, else `stage:'intake'`).

```js
{
  // existing — unchanged
  id, title, done, source, lane, assignee, asanaGid, dueOn, createdAt,

  // new
  stage: 'intake',                       // one of the 8 stages above
  events: [                              // append-only; this IS the live timeline + audit log
    { kind: 'created', at, note }        // kind: created|queued|building|review|shiptest|approval|done|blocked|unblocked
  ],
  runs: [                                // attempt history (Hermes task_runs, lite)
    { startedAt, endedAt, outcome, summary, changedFiles }  // outcome: completed|failed|blocked
  ],
  sessionId: null,                       // link to the agent session working it
  tabId: null,                           // resolved via config.sessionTabMap → the live terminal tab
  stagedAt: { building: ts, review: ts, ... }  // per-stage entry timestamps (cycle-time metrics later)
}
```

A small pure module `electron/task-pipeline.js` owns the rules:
- `VALID_STAGES`, `TRANSITIONS` (allowed `from→to` set)
- `advance(task, toStage, note)` — validates transition, sets `stage`, pushes an `events` entry, stamps `stagedAt`
- `block(task, reason)` / `unblock(task)` — event-logged, remembers prior stage
- `migrate(task)` — upgrades legacy `done`-only tasks
No I/O in this module (unit-testable in isolation).

---

## 5. Transition triggers (this is what makes the board *true*, not decorative)

The transitions already happen inside the harness; we wire them to emit `advance()` instead of inventing new automation:

1. **Intake** — `auto-mode.js`, on dispatching a new Asana task, calls `addTask` with `stage:'intake'`. Replace the `seen[]` array with **idempotent create keyed on `asanaGid`** (Hermes `idempotency_key` pattern) so a double poll can't create duplicates.
2. **Building** — when the crack_bot supervisor is launched for a task (and confirmed by the existing 20s git/worktree poll in `ProjectView.jsx` seeing the feature branch appear) → `advance(task,'building')`. Review-lane tasks skip straight to `review`.
3. **Review** — `review-audit` skill start → `advance(task,'review')`; finding-free pass closes the run as `completed`.
4. **Ship-Test** — `ship-test` skill start → `advance(task,'shiptest')`; pass/fail recorded as a `run.outcome`.
5. **Approval** — both gates `completed` → `advance(task,'approval')`. Hard stop.
6. **Done** — human approves; existing `dobius-task-done` / `completeTaskByRef` sets `stage:'done'` and `done:true`. Asana stays manual.
7. **Blocked** — any gate `failed`, or manual → `block(task, reason)`; card shows the reason and the failing run.

Mechanism question to resolve in Phase 1: the cleanest signal source. Options — (a) the skills emit a tiny marker the main process watches, (b) Conductor writes a structured `[[stage:review]]` token we parse from the PTY stream, (c) an explicit `tasks:advance` IPC the harness calls. Recommendation: **(c)** an explicit IPC + a thin fallback PTY-token parser, so transitions are deterministic but degrade gracefully.

---

## 6. UI: the Kanban tab

New component `src/components/Dashboard/Kanban/KanbanView.jsx`, added to `DashboardView.jsx` TABS (decide: new "Pipeline" tab, or repurpose the existing agent-only "Board" tab — recommend **new tab**, leave agent Board intact).

- **Columns** = the 8 stages, horizontally scrollable; `blocked` rendered as a red rail under the active columns.
- **Cards** show: title, lane color stripe (build `#58A6FF` / review `#A371F7`), source badge (asana/manual/bot), due date, latest run pass/fail dot, last 1-2 `events`.
- **Live movement:** Framer Motion `layoutId` (already in stack) makes a card physically slide column→column the instant a gate passes. This is the "see it go through the process" you asked for.
- **Drag-drop** for manual moves (validated against `TRANSITIONS`; illegal drops snap back).
- **Click a card → jump to the live work:** resolve `task.sessionId → config.sessionTabMap → tabId`, switch `activeView:'terminal'` + `activeTabId`. (Half of this already exists.)
- **Reuse** `boardNotification` + `activityTimeline` patterns from the existing Board for stage-change toasts.

State: add to Zustand store `tasks`, a `tasksByStage` selector, and a `setTaskStage` action that calls the IPC and optimistically moves the card.

---

## 7. Phased task breakdown (each becomes its own TASK-7.N.md at build time)

> Per house rules every sub-task gets PLAN → IMPLEMENT → VERIFY → REVIEW → COMMIT → GATE → LOG, on the feature branch, tsc/build green, code-reviewer subagent, before any merge.

- **7.1 — Pipeline core (data + rules), no UI.** New `electron/task-pipeline.js` (pure), extend `tasks-service.js` shape + `migrate()`. Verify: unit test all legal/illegal transitions + legacy migration; `npx vite build` exits 0.
- **7.2 — IPC + store wiring.** Add `tasks:advance` / `tasks:block` handlers (`main.js`, `preload.js`), Zustand `tasks` + `tasksByStage` + `setTaskStage`. Verify: round-trip a task through all stages via devtools; persistence survives app restart.
- **7.3 — Idempotent Asana intake.** Rework `auto-mode.js` to create tasks at `stage:'intake'` keyed on `asanaGid` (drop `seen[]`). Verify: double-poll a project, exactly one card appears.
- **7.4 — Transition triggers.** Wire supervisor-start, `review-audit`, `ship-test` to `tasks:advance`; failures → `block`. Verify: run one real build-lane task end-to-end, watch stages advance from signals (not manual).
- **7.5 — Kanban UI tab.** `KanbanView.jsx` + columns + cards + `layoutId` animation + drag-drop, added to `DashboardView`. Verify: fresh-window screenshot proof (per SKILLS-HOOKS-AGENTS screenshot rule) of a card moving.
- **7.6 — Card → terminal jump + approval gate.** Click-to-session via `sessionTabMap`; enforce hard stop at `approval`; `dobius-task-done` sets `done`. Verify: click a running card lands in its tab; approval never auto-advances.
- **7.7 (optional) — Metrics + history drawer.** Per-stage cycle time from `stagedAt`, run/attempt history drawer (Hermes `task_runs` flavor). Verify: drawer shows real timeline for a completed task.

---

## 8. Risks & mitigations

- **Signal reliability** (knowing when a skill really started/passed). Mitigation: explicit `tasks:advance` IPC as primary, PTY-token parse as fallback; never infer silently.
- **Config bloat** (events/runs growing the per-project JSON). Mitigation: cap `events` to last N, `runs` to last 10 (Hermes caps context similarly); tasks already live in their own files, not the 12MB config.
- **Legacy tasks** without `stage`. Mitigation: `migrate()` on load, covered by 7.1 tests.
- **Two checkouts on disk** (`~/dobius-plus` is a non-git stale copy). Mitigation: all work in `Projects (Code)/dobius-plus` only.
- **Scope creep toward Hermes's worker/claim-lock model.** Out of scope for this epic — Dobius runs work in your terminal tabs, not headless workers, so claim-locks aren't needed yet. Revisit only if you later want headless background workers.

## 9. Explicitly out of scope (this epic)

Headless workers + claim-lock/heartbeat; goal-mode/Ralph judge loop; cron/webhook routines; multi-board SQLite migration. All are good later epics; none are needed for the "watch Asana tasks move through the pipeline" outcome.

---

## 10. Open decisions for you (before 7.1)

1. New **"Pipeline"** tab vs. repurpose existing **"Board"** tab. (Rec: new tab.)
2. Transition signal mechanism: explicit IPC vs. PTY token vs. both. (Rec: both, IPC primary.)
3. Keep `done:boolean` in sync with `stage:'done'` for back-compat with `dobius-task-done`? (Rec: yes.)

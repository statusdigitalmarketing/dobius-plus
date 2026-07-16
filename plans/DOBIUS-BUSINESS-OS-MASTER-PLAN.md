# Dobius+ → Internal Business OS — Master Plan

> **Status:** PLANNING ONLY. No build started. Date: 2026-06-22.
> **This is the master doc.** Part 1 documents how Dobius+ is built *today* (the
> as-is architecture, verified against the code). Part 2 onward is how we build the
> internal business OS *on top* of it. The companion `BUSINESS-OS-PLAN.md` holds the
> raw research notes and sources; this doc supersedes it for the plan itself.

---

# PART 1 — HOW DOBIUS+ IS BUILT TODAY (as-is architecture)

## 1.1 What it is

Dobius+ is an Electron desktop app that wraps coding-agent CLIs (Claude Code, and
Codex/OpenAI accounts) in themed, multi-tab terminal windows, with a conversation
sidebar, a multi-tab dashboard, and an autonomous Asana-driven build pipeline. It is
**local-first and single-operator**: all state lives on one Mac, in local files.

By the numbers (verified): ~26 main-process service modules (~9,400 lines),
`main.js` registers **152 IPC handlers**, a 307-line `preload.js` context bridge,
**33 renderer components**, ~20 dashboard tabs. Native deps: `node-pty` and
`better-sqlite3`.

## 1.2 Tech stack

- **Shell:** Electron 33+ (main process + per-window renderers, IPC)
- **Renderer:** Vite 6/7 + React 19 + Zustand + Tailwind 4
- **Terminal:** xterm.js (+ fit, web-links addons) ⇄ node-pty
- **Watchers:** chokidar (on `~/.claude/` and project dirs)
- **Local DB (native, present):** better-sqlite3
- **Charts/anim:** recharts, framer-motion
- **Packaging:** electron-builder (signed + notarized mac builds), GitHub Releases auto-update

## 1.3 Process model

- **Main process** (`electron/`): owns windows, node-pty sessions, file parsing, all
  IPC, config persistence, the autonomous pipeline services.
- **Renderer** (`src/`): React app — terminal panes, sidebar, dashboard.
- **Multi-window:** **each project gets its own `BrowserWindow`** (`window-manager.js`),
  project path passed via URL query. Plus tear-off tab windows and a single phone-shaped
  "Visual" preview window. *(This per-project-window model is the main memory driver — see
  Part 4.)*
- **Security posture:** `contextIsolation: true`, `nodeIntegration: false`, preload-only
  API surface. Sound.

## 1.4 Main-process module map (grouped by role)

| Role | Modules |
|---|---|
| **Terminal core** | `terminal-manager.js` (PTY lifecycle), `window-manager.js` (windows) |
| **Autonomous pipeline** | `asana-queue.js` (intake), `auto-mode.js` (poll+dispatch), `voice-conductor.js` + `voice-bridge.js` (the Conductor, 1,055 lines), `agent-spawner.js` (spawn agents), `work-registry.js` (track + concurrency caps), `task-pipeline.js` (state machine) + `tasks-service.js` (persistence) |
| **Comms** | `imessage-bridge.js` (drive by texting), `conversation-router.js` (ask/await replies), Telegram path |
| **Data (read-only)** | `data-service.js` (1,021 lines — reads `~/.claude/*`), `data-utils.js`, `watcher-service.js`, `file-change-service.js` |
| **Dev integrations** | `git-service.js` (gh CLI), `deploy-service.js`, `visual-server.js`, `build-monitor-service.js` + `build-monitor-watcher.js`, `scheduled-tasks.js` |
| **Remote access** | `mobile-server.js` (478 lines — serve terminals to phone) |
| **Platform** | `main.js` (wiring/IPC), `preload.js` (bridge), `config-manager.js` (885 lines — persistence), `auto-updater.js` |

## 1.5 The terminal core (the heart)

`terminal-manager.js` holds a `Map<id, entry>` of live PTYs **in the main process**.
Key design facts that matter for the build:

- The PTY is **already decoupled from any single window.** Each entry has a
  `subscribers: Set<sink>` and a **rolling 1MB output buffer** (`OUTPUT_BUFFER_BYTES`),
  built so a "late subscriber" (the phone) replays real scrollback.
- **Catch:** the rolling buffer is only maintained when `subscribers.size > 0` (i.e.
  for mobile). The desktop path streams straight to `webContents` with no replay — which
  is *why* the current rule is "all tabs stay mounted" (unmount kills the xterm view and
  there's no buffer to rehydrate from on desktop).
- Graceful close sends **Ctrl+C twice** so Claude prints its resume ID before the PTY
  dies. PTYs can be **reassigned** to another window's webContents (tab tear-off).
- Process introspection via `pgrep`/`ps`/`lsof` (busy-child detection, resume-id sniff,
  cwd lookup).

## 1.6 The autonomous pipeline (Asana → ship)

```
Asana ──auto-mode (poll every 10m, cap 3/tick, seen[] guard)──▶ Voice Conductor tab
   │                                                                   │ routes + launches
   │                                                                   ▼
   │                                                       crack_bot/crack_repair supervisor
   │                                                                   │ spawns agent tab
   │                                                                   ▼
   │                            work-registry  ◀── tracks ── node-pty terminal (claude --model …)
   │                            (caps: maxConcurrentAgents=1, maxPerProject=1)
   │                                                                   │ on exit
   ▼                                                                   ▼
task-pipeline state machine:                              iMessage/Telegram final report
intake→queued→building→review→shiptest→approval→done       (to Sam, 1:1)
   (approval→done is HUMAN-ONLY, enforced in code)
```

- **Two human gates** are hard-coded: nothing posts to Asana and nothing pushes/deploys
  without explicit confirmation.
- **Model selection today** is hard-coded Claude in ~4 places (`agent-spawner.js`,
  `OrchestratorView.jsx`, `Agents.jsx`, `voice-conductor.js` → `CONDUCTOR_MODEL`).
  Accounts already support `type: 'claude' | 'codex'`; a codex account injects
  `OPENAI_API_KEY` into the terminal env (`main.js`).

## 1.7 The renderer

- `App.jsx` + `store/store.js` (Zustand). Hooks: `useTerminal`, `useSessions`,
  `useStats`, `useGit`, `useBuildMonitor`, `useAgentActivity`, `useTabActivity`.
- **Component groups:** `Launcher/` (project grid), `Project/` (terminal panes, sidebar,
  conversation cards), `Dashboard/` (~20 tabs: Overview, Stats, Costs, Sessions, Plans,
  Skills, MCPServers, Search, Prompts, ChangeFeed, Board, Kanban, Orchestrator, Agents,
  Git, Checkpoints, ClaudeMdEditor, Notes, BuildMonitor, Settings, Updates), `shared/`.
- **All terminal tabs stay mounted** (`display:none`) to preserve the xterm buffer +
  PTY link — the current memory-vs-correctness tradeoff.

## 1.8 IPC surface

152 handlers exposed through `preload.js` as `window.electronAPI`, namespaced:
terminal, agents, agent-memory, orchestration, file/notes, claude-hooks, checkpoints,
data (read-only `~/.claude`), filewatcher, config, accounts, window, mobile-server,
imessage-bridge, updater, build-monitor, git, tasks, asana, auto-mode, visual.

## 1.9 Persistence model (the critical constraint)

- **Everything shared lives in ONE local `config.json`** (`config-manager.js`, atomic
  write) at `~/Library/Application Support/dobius-plus/config.json`. It holds: projects,
  per-project settings, accounts, `asanaQueue`, `workRegistry`, orchestration runs,
  tasks, tabs/scrollback, pins, session tags. **This single-user file is the hard blocker
  for multi-user** (Part 3).
- **Read-only data sources:** `data-service.js` reads `~/.claude/history.jsonl`,
  `stats-cache.json`, `settings.json`, transcripts, `plans/`, `skills/`. Never written.
- `better-sqlite3` is already a dependency — a local DB is available without new native
  deps.

## 1.10 Comms today

1:1 only. `imessage-bridge.js` + `conversation-router.js` send to **one person (Sam)**
via `sendImessageToSelf` and await a single reply (5-min timeout). The Voice Conductor
asks yes/no questions over iMessage. There is **no multi-user, no channels, no threads.**

## 1.11 Remote access today

`mobile-server.js` already **serves terminals to authenticated remote devices** (device
tokens, bind mode, scrollback replay via the subscriber buffer). `visual-server.js`
serves the rendered project preview to the Visual window. This is the embryo of the
thin-client model the team build needs.

## 1.12 Build / release

Vite build (+ mobile build) → `electron-builder --mac` (signed/notarized) → GitHub
Releases auto-update. `npm run build` must exit 0 (JS project, no tsc). Native modules
(`node-pty`, `better-sqlite3`) need `electron-rebuild` after dependency changes.

---

# PART 2 — THE VISION (what we're building on top)

**North star:** Dobius+ stays a wrapper around the terminal at its core. The
business-operating layer lives in a **separate, lightweight companion app (the "Hub")**
that talks to Dobius+ through a shared foundation. Two apps, one nervous system — Dobius+
is the hands (does the work), the Hub is the office (where the team organizes and talks).
The work still splits into three sides:

| Pillar | Today | Build |
|---|---|---|
| **Terminal side** | Exists (the whole runner) | Extract to a daemon; thin clients |
| **Dashboard side** | Partly exists (~20 tabs, monitors) | Single-window reskin + aggregate |
| **Comms side** | 1:1 iMessage only | Multi-user threads → channels |
| **Foundation** | One local `config.json` | Shared cloud data + auth (NEW) |

**Locked decisions:** growing internal team (3+), **internal only — no client logins**,
full internal business OS, **hybrid** with Asana (keep) + replace internal comms, single
**Mac runner**, everyone on the **desktop app**, **cloud data layer** (Supabase) with the
Mac as runner, comms **all three flavors phased**.

---

# PART 3 — TARGET ARCHITECTURE: TWO APPS, ONE FOUNDATION

## 3.1 Two apps, one foundation

Instead of one app doing everything, **two apps that talk through a shared foundation:**

- **Dobius+ (the runner app) — existing, machine-bound.** Stays desktop Electron on your
  Mac. Owns terminals, agents, builds. Publishes work-state up to the foundation and
  consumes commands from it. Holds all secrets locally. Only your machine runs it.
- **The Hub (the companion app) — NEW, lightweight.** No `node-pty`, so it can be Tauri or
  web (not locked to Electron). This is what the team installs or opens. Multi-project
  organization + team communication. Reads work-state; writes tasks, messages, commands.
- **The foundation (Supabase) — NEW, always-on.** The shared bus *and* the contract
  between the two apps. Neither app calls the other directly; both are clients of this.

```
   ┌────────────────────────────────────────────────────────┐
   │  CONTROL PLANE — Supabase (cloud, always-on)            │
   │  Auth · Postgres (RLS, project-isolated) · Realtime     │
   └───────▲──────────────▲───────────────▲─────────────────┘
           │ team apps     │                │
   ┌───────┴───────┐ ┌─────┴───────┐ ┌──────┴────────┐
   │ TERMINAL side │ │ DASHBOARD   │ │  COMMS side   │   ← the Hub app (light, no PTYs)
   │ (status view) │ │ (monitor)   │ │ (threads/chat)│
   └───────▲───────┘ └─────────────┘ └───────────────┘
           │ commands / status
   ┌───────┴────────────────────────┐
   │  EXECUTION PLANE — runner daemon│  ← headless, on your Mac only
   │  node-pty agents · build loop   │
   └─────────────────────────────────┘
```

## 3.2 The foundation (critical path)

Replace the single local `config.json` for *shared* state with Supabase. Schema centered
on `projects`, `tasks`, `users`, `messages`, `assets`, `work_runs`. **Project-level
isolation (RLS) baked in from the first migration** so `axiom-connect` and
`elysium-connect` data can never bleed across (the confidentiality rule, enforced in the
DB, not just the UI). Keep **secrets local** (never in the synced store). `better-sqlite3`
can serve as the local read cache for offline/speed. This foundation is now the explicit
**contract** between the two apps (see 3.6).

## 3.3 The runner daemon

Extract the terminal/agent engine out of Electron into a **headless Node service**. It
already half-exists: `terminal-manager.js`'s subscriber + rolling-buffer model and
`mobile-server.js`'s authenticated streaming are exactly the seams. Closing all windows
frees Chromium memory while builds keep running; the daemon is later relocatable to an
always-on box with no rewrite.

## 3.4 Single-window shell

Replace per-project `BrowserWindow`s with **one window + in-app project switching** (the
Acme-style sidebar). Terminals become the "Workspace" module inside the shell. This is
both the UX direction and the biggest memory win (Part 4).

## 3.5 Existing seam → new system map

| Need | Reuse this | Add |
|---|---|---|
| Multi-client terminals | `mobile-server.js` streaming + subscriber buffer | Generalize to desktop peers; status-only for non-runner users |
| Job queue / concurrency | `work-registry.js` caps | Surface to control plane; per-project queue |
| Task spine | `task-pipeline.js` + `tasks-service.js` + `tasksSyncAsana` | Move store to Supabase; two-way Asana field map |
| Multi-project monitor | BuildMonitor `detectActive`, Board, Kanban | Aggregate across projects in one view |
| Comms | `conversation-router.js` ask/await | Multi-user threads/channels on Realtime |
| Routines | `scheduled-tasks.js` + `auto-mode.js` | UI surface in the shell |

## 3.6 The two apps & their contract

Two apps, talking **through the foundation, never directly.** The contract is a small set
of shared tables plus a versioned event stream:

| Table | Written by | Read by | Holds |
|---|---|---|---|
| `projects` | Hub | both | project list + `client_owned` flag (drives isolation) |
| `work_runs` | Dobius+ | Hub | one row per build/review run: stage, model, status |
| `work_events` | Dobius+ | Hub | stream: `build_started`, `blocked`, `needs_approval`, `build_done`, `review_done`, `shiptest_done` |
| `tasks` | Hub | both | task list, `asana_gid`, stage, assignee |
| `commands` | Hub | Dobius+ | `approve`, `start_task`, `stop_run` — the Hub's way to drive the runner |
| `messages` | both | both | per-project threads; `kind` = human \| agent |
| `users` | Hub | both | identity + role |
| presence | (Realtime, ephemeral) | both | who's online / viewing |

**Flow:** Dobius+ writes `work_runs` / `work_events` (and agent `messages` into threads).
The Hub writes `tasks`, `commands`, and human `messages`. Both subscribe over Realtime.
**Rule:** the event schema is versioned and **additive-only** (`event_version` field) so an
older Hub degrades gracefully instead of breaking — this is the inter-app version-skew
guard.

This reuses what already exists: `work-registry.js` already produces run/status data, and
`mobile-server.js` already proves Dobius+ can stream to external authenticated clients —
here it streams to the foundation instead of to a phone.

---

# PART 4 — WEIGHT & PERFORMANCE STRATEGY

Memory comes from **execution**, not the dashboard. Levers, ranked:

1. **Split the runner out of Electron** (daemon) — close UI → reclaim all Chromium memory; builds keep running; teammates run UI-only with zero PTY weight.
2. **One window, in-app project switching** — kills the per-project Chromium multiplier (the confirmed top driver in `window-manager.js`).
3. **Unmount inactive terminals safely** — *small* change: always maintain the rolling buffer (today mobile-only) and add replay-on-remount, then tear down inactive xterm canvases. Reverses the "all tabs mounted" rule because its premise no longer holds.
4. **Cap agent concurrency** — already present (`work-registry` caps); bounds peak RAM.
5. **Lazy-load routes, virtualize long lists, drop recharts for a lean charting lib.**
6. **Keep heavy data out of renderer state**; stream/paginate from daemon or Supabase.
7. **One shared Realtime connection** (Broadcast for high-freq, Presence for slow state).

Ceiling: Electron has a ~150–250MB floor. That ceiling now only applies to **Dobius+ (the
runner)**, which needs Electron for `node-pty`. **The Hub app has no terminals, so it is
free of that constraint** — it can be Tauri (tiny) or a web app from day one, genuinely
light with no rewrite. Splitting into two apps is itself the biggest weight win.

---

# PART 5 — PHASED ROADMAP

**Phase 0 — Foundation = the contract (critical path).** Supabase: auth + schema
(`projects`, `work_runs`, `work_events`, `tasks`, `commands`, `messages`, `users`) +
Realtime + RLS with project isolation from migration #1. This is the shared bus both apps
speak. Secrets stay local in Dobius+. Define what migrates off `config.json` vs. stays
local.

**Phase 1 — Dobius+ outbound bridge + Hub skeleton.** Teach Dobius+ to publish
`work_runs` / `work_events` to the foundation and consume `commands` (reusing the
`mobile-server` / `work-registry` seams). Stand up the lightweight **Hub app** (Tauri or
web) shell — sidebar, project list, live status read from the foundation. The runner stays
inside Dobius+ on your Mac. Multi-model recipe table (builder ≠ reviewer) lands here too.

**Phase 2 — Dashboard side.** Home, Projects, Analytics (reuse Costs/Stats), Routines
(reuse scheduled-tasks), Team. Read-mostly, fastest visible payoff.

**Phase 3 — Comms side.** Lightweight first (agent updates + thread-per-task), then
channels/DMs. Decide build-vs-integrate before full chat.

**Phase 4 — Business modules.** Calendar (Google Workspace), Customers, Finance — thin
read-only dashboards first. Money actions stay manual (house rule).

Cross-cutting: secrets management, confidentiality partitioning, hardening the
cross-model review gate (the real source of "no bugs").

---

# PART 6 — PROBLEMS, GAPS & RISKS

1. **Single-Mac runner = bottleneck + single point of failure** (node-pty not thread-safe; team blocked if Mac is off). Mitigate: queue + caps (exist), design daemon relocatable.
2. **Terminals can't be safely shared** — every PTY runs at your permission level. Teammates get *status*, never a raw shell on your Mac.
3. **`config.json` is single-user** — the hard blocker; the foundation must land first.
4. **No identity layer** — users/roles/sessions are all net-new.
5. **Secrets become a security problem** at multi-user — need a local-only/vault boundary before Phase 0 writes shared data. (House rule: never expose credentials.)
6. **Building full chat is the biggest scope trap** — teams extend rather than rebuild Slack; adoption, not code, is the hard part. Lead with thread-per-work.
7. **Hybrid Asana = two sources of truth** — define canonical field ownership + sync direction.
8. **"Full business OS" is huge surface area** — Finance/Customers/Calendar are each a product; keep them thin/read-only first. Never move money (house rule).
9. **Confidentiality collision** — axiom + elysium in one DB/UI is exactly the cross-contamination the workspace rule forbids; enforce isolation in the schema (RLS), not the UI.
10. **Breadth threatens the "no bugs" goal** — the cross-model review gate is the hard 80%; don't let module sprawl starve it.
11. **Maintenance load** for a near-solo operator across three pillars.
12. **Model house-rule conflict** — multi-model routing vs. "always Opus for subagents"; update consciously, scoped to Dobius+.
13. **The inter-app contract is a real interface.** Two apps + a shared schema means version skew between them. Keep the event schema versioned and additive-only; a Hub on an older schema must degrade gracefully, not crash. The contract (3.6) is now a first-class thing to design and maintain.

---

# PART 7 — OPEN DECISIONS (next round)

- Backend: **Supabase** (recommended — auth+Postgres+Realtime+RLS in one) vs. Neon + bespoke auth.
- How teammate apps reach the Mac runner: Tailscale/VPN mesh vs. cloud relay.
- Secrets boundary: local-only vs. managed vault.
- Asana canonical-field mapping.
- Comms: build full chat vs. integrate vs. thread-per-work only.
- Finance/Customers v1 depth: read-only dashboard vs. real workflows.

---

*Feasibility verdict: buildable. The terminal and dashboard pillars are close (the PTY
subscriber model, the mobile streaming server, and the concurrency registry already
exist). The whole plan hinges on one critical-path item — replacing the single local
`config.json` with a real shared data layer. Sequence everything behind that.*

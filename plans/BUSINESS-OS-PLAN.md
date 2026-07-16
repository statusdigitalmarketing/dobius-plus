# Dobius+ → Internal Business OS — Full Plan & Research

> Status: **PLANNING / RESEARCH ONLY.** No build started. This doc captures the
> vision, the decisions locked so far, the architecture, a phased roadmap, and
> (most importantly) the problems, gaps, and risks found during research.
> Date: 2026-06-22.

---

## 1. North star

Dobius+ **stays a wrapper around the terminal at its core.** The business-operating
layer wraps *around* that core, in the same desktop app the team installs. The
terminal/agent engine is not replaced or demoted — it becomes one pillar inside a
larger shell.

The system splits into **three pillars on one shared foundation**:

| Pillar | What it is | Status today |
|---|---|---|
| **Terminal side** | The agent engine: terminals, node-pty, Claude Code / Codex / OpenCode, the autonomous Asana → build → review → ship pipeline. Runs on the Mac. | **Exists.** This is today's Dobius+. |
| **Dashboard side** | The Acme-style shell: Home, Projects, Analytics, Calendar, Team, Customers, Finance, Routines, creative/asset library. | **Partly exists** (Board, Orchestrator, Costs, Stats, scheduled-tasks). Mostly a reskin + new modules. |
| **Comms side** | Internal communication: agent ↔ human updates, task threads, eventually channels/DMs. | **Net-new** (today it's iMessage/Telegram/Conductor asks only). |
| **Foundation** | Shared data layer + auth that all three pillars and all team members read/write. | **Net-new.** Today everything is local files + local config.json. |

---

## 2. Decisions locked (from the mapping session)

1. **Seats:** A growing internal team (3+). **Internal only — no client logins ever.**
2. **Core job:** Full internal business OS (dev + comms + management + creative).
3. **Shell:** Acme-style sidebar is the primary UI; the terminal experience becomes
   the "Workspace/Runner" module *inside* it. Terminal core stays the heart.
4. **Tools:** **Hybrid** — keep Asana where it earns its place; replace internal comms.
5. **Where execution runs:** Single runner on **your Mac** (for now).
6. **Access:** Everyone installs the **desktop app** (no web client in v1).
7. **The hub (decided):** **Small always-on cloud data layer (Supabase)** holds shared
   data; the Mac stays the runner. Rationale: comms and shared task state can't go
   dark when your Mac sleeps. Decouples *data* (cloud, always-on) from *execution*
   (Mac, machine-bound). Movable later with no migration.
8. **Comms:** All three flavors, **phased** — lightweight updates + thread-per-task
   first, channels/DMs later.

---

## 3. Architecture

```
        ┌─────────────────────────────────────────────────────────┐
        │   FOUNDATION (cloud, always-on) — Supabase                │
        │   Postgres + Auth + Realtime + Row-Level Security         │
        │   Projects · Tasks · Users · Messages · Assets (metadata) │
        └───────────────▲───────────────▲───────────────▲──────────┘
                        │               │               │
        ┌───────────────┴──┐  ┌─────────┴────────┐  ┌───┴──────────────┐
        │  TERMINAL SIDE   │  │  DASHBOARD SIDE  │  │   COMMS SIDE     │
        │  (Mac runner)    │  │  (read-mostly)   │  │  (read/write)    │
        │  node-pty agents │  │  Home/Projects/  │  │  Inbox/threads/  │
        │  autonomous loop │  │  Analytics/...   │  │  channels        │
        └──────────────────┘  └──────────────────┘  └──────────────────┘
              ▲  builds here only            all team members' desktop apps
              │                              connect to the foundation
        Your Mac (single runner)
```

- **Data lives in the cloud foundation; builds run on one Mac.** Teammates' desktop
  apps are clients of the foundation. They see build *status/output*, not a raw
  shell on your machine (see Risk #2).
- **Asana stays an upstream source** for build/review intake (existing `auto-mode.js`
  + `asana-queue.js`); the foundation is canonical for everything Dobius-native.

---

## 4. Module map (sidebar → exists vs. new)

| Sidebar item | Maps to | Build size |
|---|---|---|
| Home / Dashboard | New shell aggregating existing data | Medium |
| Inbox (Comms) | New + existing agent updates (Conductor/iMessage/Telegram) | Large |
| Analytics | Exists: `Costs.jsx`, `Stats.jsx`, `data-service.js` | Small (reskin) |
| Projects | Exists: portfolio/launcher + per-project config | Small (reskin) |
| Workspace / Terminals | Exists: the whole terminal core | Small (embed) |
| Routines | Exists: `scheduled-tasks.js` + `auto-mode.js` | Small (UI) |
| Calendar | New — back with Google Workspace MCP | Medium |
| Team | New — roster of humans + agents | Medium |
| Customers | New module | Large |
| Finance | Partial: cost tracking exists; revenue/Stripe new | Large |
| Creative / Assets | New — per-project asset library, Higgsfield integration | Large |
| API Keys / Webhooks | New dev-settings surface | Medium |

---

## 5. Phased roadmap (the only way to reach "all of it")

**Phase 0 — Foundation (the spine).** Supabase project: auth, Postgres schema for
Projects/Tasks/Users, Realtime, Row-Level Security with **project-level isolation
baked in from day one** (see Risk #9). Shell app skeleton (sidebar + routing).
Secrets stay local, never in the synced store (Risk #5).

**Phase 1 — Terminal side, hardened as the Runner.** Bring the existing terminal +
autonomous engine in as the "Workspace" module. Add a **job queue + concurrency cap**
so one Mac can serialize team work. Teammates get **read-only build status**, not raw
PTY. Add the multi-model recipe table (builder model ≠ reviewer model).

**Phase 2 — Dashboard side.** Home, Projects, Analytics (reuse Costs/Stats), Routines
(reuse scheduled-tasks), Team. Read-mostly, lowest risk, fastest visible payoff.

**Phase 3 — Comms side.** Lightweight first: agent updates + thread-per-task tied to
the work. Decide **build-vs-integrate** for full channels/DMs before committing (Risk #6).

**Phase 4 — Business modules.** Calendar (Google Workspace MCP), Customers, Finance —
**read-only dashboards first**, not full apps. Money actions stay manual (house rule).

**Cross-cutting throughout:** secrets management, confidentiality partitioning, and
hardening the cross-model review gate (the real source of "no bugs").

---

## 6. Problems, Gaps & Risks (the important part)

### Technical / architecture

1. **Single-Mac runner is a hard bottleneck and a single point of failure.** node-pty
   is not thread-safe, and every build funnels through one machine; if the Mac sleeps
   or reboots, *all* autonomous work halts for the whole team. Confirmed as a known
   single-point-of-failure pattern for concurrent multi-user node-pty.
   **Mitigation:** job queue + concurrency cap (you already have `MAX_TASKS_PER_TICK`),
   design the runner to be relocatable to an always-on box later, consider containerizing.

2. **Terminals cannot be safely shared across users.** Every node-pty process runs at
   the parent's permission level — handing a teammate's desktop app a live shell on
   your Mac = arbitrary command execution as you. **Gap:** "everyone installs the
   desktop app" must NOT mean everyone gets a PTY on your machine. Teammates see build
   output/status through the foundation; only your Mac holds real shells.

3. **Multi-user shared state is net-new and non-trivial.** Today everything reads local
   files (`~/.claude/*`, local `config.json`). Moving to shared cloud data is a real
   data-model migration even with Supabase. Industry note: *managing sync state is
   harder than sync itself* — disconnects, offline edits, and conflicts all need a
   policy (last-write-wins for low-stakes, field-merge for records).

4. **No identity layer exists.** Zero concept of users/roles/sessions today. Accounts,
   roles, and per-user permissions are all foundational new work.

5. **Secrets management becomes a real security problem.** `config.json` already holds
   provider API keys locally. A multi-user business OS touching Stripe, Supabase, and
   client infra cannot keep secrets in a synced shared store. **House rule:** never
   commit/expose credentials. **Gap:** need a secrets boundary (local-only or a vault),
   decided before Phase 0 writes anything shared.

### Product / scope

6. **Building chat from scratch is a classic low-ROI time sink.** Research is blunt:
   organizations extend existing tools rather than rebuild Slack, and *adoption* (not
   code) is the real barrier even for a small team. The "all three" comms answer is the
   single biggest scope risk in the plan. **Recommendation:** lead with
   **thread-per-work** comms (differentiated, light, tied to tasks); treat full
   channels/DMs as build-vs-integrate, not an assumed build.

7. **Hybrid Asana = two sources of truth for tasks.** A native Projects/Tasks module
   plus Asana sync invites drift and duplication. `auto-mode.js` is one-way *intake*;
   two-way sync is much harder. **Gap:** define canonical ownership per field and sync
   direction before building the Tasks module.

8. **"Full business OS" is enormous surface area.** Customers, Finance, and Calendar are
   each a product on their own. Finance carries accuracy + compliance weight (real money
   data). **House rule:** never move money/execute trades. **Risk:** spreading thin.
   Keep these as thin read-only dashboards first.

9. **Confidentiality/isolation collision — even "internal only."** The system aggregates
   `axiom-connect` AND `elysium-connect` data in one app/DB. Workspace rule: those two
   must **never** cross-contaminate (client-confidentiality, not just code hygiene). A
   unified Projects/Customers/Finance view that mixes them is exactly the failure mode.
   **Gap:** project-level data partitioning + access scoping must exist in the schema
   from Phase 0, not be retrofitted.

### Process / operational

10. **Breadth threatens the "no bugs" goal.** Autonomy quality lives almost entirely in
    the cross-model review gate (the hard 80%). Every new business module pulls focus
    from hardening that gate. **Risk:** breadth over depth.

11. **Maintenance load.** The existing Done Bar + house rules are already heavy; a
    three-pillar app multiplies the surface that must stay green for a near-solo operator.

12. **Model house-rule conflict.** Multi-model routing contradicts "always Opus for
    subagents." Needs a conscious rule update scoped to Dobius+.

---

## 7. Open decisions (next round)

- **Backend choice:** Supabase (recommended — auth + Postgres + Realtime + RLS in one)
  vs. Neon + bespoke auth. Leaning Supabase.
- **How teammate apps reach the Mac runner:** Tailscale/VPN mesh vs. cloud relay. (PTY
  session-sync over mesh transports is an active, viable pattern.)
- **Secrets boundary:** local-only vs. a managed vault.
- **Asana canonical-field mapping:** which fields Dobius owns vs. Asana owns.
- **Comms:** build full chat vs. integrate vs. thread-per-work only.
- **Finance/Customers v1 depth:** read-only dashboard vs. real workflows.

---

## 8. Architecture map & feasibility (verified against the code)

Read of the real wiring: **1,637-line `main.js` registering 152 IPC handlers**, a
307-line `preload.js` context-bridge, ~26 electron service modules (9,372 lines),
33 dashboard components. `contextIsolation: true`, `nodeIntegration: false` — sound
security posture. Native deps: `node-pty` and `better-sqlite3` (SQLite already in the
tree).

### How it actually flows today

```
Asana ──auto-mode(poll 10m)──▶ Voice Conductor tab ──▶ crack_bot supervisor
                                      │                      │ spawns
                                      ▼                      ▼
                              work-registry            node-pty terminals (terminal-manager)
                              (status + caps)          │ PTY lives in MAIN process
                                      │                │ rolling 1MB output buffer
                                      ▼                │ subscribers: Set<sink>
                              iMessage/Telegram ◀──────┘ webContents.send('terminal:data')
                              (to Sam, 1:1)
        Renderer (per-project BrowserWindow) ◀── 152 IPC handlers ── all services
        State persists to: ONE local config.json (config-manager, 885 lines)
```

### What ALREADY exists that the vision needs (the good news)

- **The PTY core is already decoupled from the UI.** `terminal-manager.js` keeps the
  PTY in the **main process** with a `subscribers` Set and a rolling 1MB output buffer,
  built so "late subscribers" (the phone) get real scrollback. The headless-runner split
  is **half-built** — this is the seam the daemon plugs into, not a rewrite.
- **A remote-client server already exists.** `mobile-server.js` (478 lines) streams
  terminals to authenticated remote devices (device tokens, bind mode). The thin-client
  model for teammates is **already prototyped**.
- **Concurrency control exists.** `work-registry.js` enforces `maxConcurrentAgents` /
  `maxPerProject` caps and tracks every dispatched work item — the job-queue + multi-
  project monitoring foundation is in place.
- **Task state + Asana sync exist.** `task-pipeline.js` (tested state machine),
  `tasks-service.js` (persistence), `tasksSyncAsana` IPC (per-project sync), and
  `auto-mode.js` (intake) cover the task spine.
- **Multi-project monitoring exists in embryo.** BuildMonitor (`detectActive` via
  `pgrep`), Board, Kanban, and `work-registry.getStatus()` already watch many runs.

### What genuinely blocks multi-user (the real new construction)

1. **All shared state lives in ONE local `config.json`.** work-registry, orchestration,
   tasks, accounts — everything dumps into a single local file. This is the hard
   blocker: a single-user file is not a multi-user data store. **→ Foundation work:**
   move shared state to Supabase (cloud, always-on) and/or the already-present
   `better-sqlite3` for a local cache. This is the critical path; little else can be
   truly multi-user until it lands.
2. **One `BrowserWindow` per project** (`window-manager.js`) = multiplied Chromium
   memory. **→ Weight work:** single window + in-app project switching.
3. **No identity layer.** Zero users/roles/sessions today.
4. **Comms is 1:1 to Sam.** `imessage-bridge.js` / `conversation-router.js` send to one
   person via `sendImessageToSelf`. Multi-user human comms is net-new.

### Feasibility verdict

**Buildable — and the terminal/monitoring pillars are far closer than expected**
because the PTY-subscriber model, the mobile streaming server, and the concurrency
registry already exist. The whole project hinges on **one critical-path item: replacing
the single local `config.json` with a real shared data layer.** Sequence everything
behind that.

| Pillar | Existing coverage | New build | Confidence |
|---|---|---|---|
| Terminal side (runner) | High (subscriber model, mobile server, caps) | Daemon extraction, buffer-replay on remount | **High** |
| Dashboard side (monitor) | Medium-high (33 components, monitors) | Single-window reskin, aggregate across projects | **High** |
| Comms side | Low (1:1 iMessage) | Multi-user threads/channels on the foundation | **Medium** |
| Foundation (data + auth) | Low (local config.json only) | Supabase + auth + RLS isolation | **Medium — critical path** |

### Lightweight fix, grounded in the code

The "unmount inactive terminals" optimization is a **small extension**, not a rebuild:
`terminal-manager.js` already maintains a rolling output buffer, but only when a mobile
subscriber is attached (`entry.subscribers.size > 0`). Maintain that buffer for desktop
too and add a replay-on-remount path, and inactive xterm views can be torn down safely
and rehydrated on focus — directly reversing the "all tabs stay mounted" rule because
its premise (buffer dies on unmount) no longer holds once the buffer is always kept.

---

## Sources (research)

- Supabase + Electron realtime/presence: https://supabase.com/docs/guides/realtime/presence
- Supabase realtime general availability: https://supabase.com/blog/supabase-realtime-multiplayer-general-availability
- node-pty multi-user + security warnings: https://github.com/microsoft/node-pty
- node-pty with socket.io for multiple users: https://medium.com/@deysouvik700/efficient-and-scalable-usage-of-node-js-pty-with-socket-io-for-multiple-users-402851075c4a
- Local-first sync engines (2026 landscape): https://github.com/alexanderop/awesome-local-first
- Offline-first Electron architecture: https://medium.com/@raamsri/building-an-electron-app-offline-first-local-first-architecture-for-privacy-desktop-software-ed32bc7384d9
- Why teams extend rather than rebuild chat: https://slack.com/blog/transformation/how-our-it-team-builds-on-the-slack-platform

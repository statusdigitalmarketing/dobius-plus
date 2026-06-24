# Dobius+ Hub — Detailed Build Plan

> **Status:** PLAN ONLY — no build started. Date: 2026-06-22.
> **Companion to** `DOBIUS-BUSINESS-OS-MASTER-PLAN.md` (architecture) and
> `BUSINESS-OS-PLAN.md` (research/sources). This doc is the actionable, phase-by-phase
> build with schema, file-level tasks, verification, and exit criteria.

---

## 0. The shape in one paragraph

Two apps + one foundation. **Dobius+** (existing Electron app, stays on your Mac) is the
**runner** — it does the agent work and *publishes* what's happening. **The Hub** (new,
lightweight web app) is the **command center + team comms** — it *reads* work-state and
*writes* tasks, messages, and commands. **Supabase** is the shared foundation: the bus and
the contract between them. Neither app calls the other directly.

A quiet but important benefit of this design: **teammates' Hub never has to reach your
Mac.** Both apps only need an outbound connection to Supabase, so the "how do remote
teammates connect to the runner" problem (VPN/Tailscale) largely disappears — your Mac just
needs outbound internet.

---

## 1. Competitors & whitespace (why this is worth building)

The "manage many AI coding agents" space is crowded — **Conductor**, **Vibe Kanban**,
**Composio AO**, **Emdash**, **AgentsRoom** — but they are all the *execution* side
(parallel agents in git worktrees, diff review, PR merge) for a **single developer**.
That is what Dobius+ already is. **None of them is a team-comms + multi-project business
hub.** That is the Hub's whitespace.

- **Don't rebuild** the orchestration layer — Dobius+ covers it; those tools are references.
- **Borrow one pattern:** the "group sessions by state" Kanban (Composio/Vibe Kanban) maps
  directly onto our `task-pipeline` stages — use it for the portfolio board.
- **Design references:** Conductor / Vibe Kanban (agent side), Linear / Height (team org
  feel — neither is agent-aware, which is our edge).

---

## 2. Locked stack

| Layer | Choice | Why |
|---|---|---|
| **Hub app** | Vite + React + TypeScript + **Tailwind v4 + shadcn/ui** | 21st.dev components *are* shadcn/ui — they drop in with zero rework |
| **Hub UI sourcing** | **21st.dev** registry + **Magic MCP** in editor | Fast, polished UI; generate/paste components |
| **Delivery** | **Web-first**, wrap in **Tauri** later if a desktop app is wanted | Lightest possible; managers open a URL, no install |
| **Foundation** | **Supabase** (Auth + Postgres + Realtime + RLS) | Auth, data, realtime, row-level isolation in one |
| **Runner** | **Dobius+ unchanged** (Electron + node-pty) | Keep it the terminal wrapper; only add an outbound bridge |

**Hard rule:** adopt shadcn/ui as the Hub's component system from commit one. Skipping it
means every 21st.dev component needs adaptation.

---

## 3. The data contract — Supabase schema (detail)

Migration #1. Types abbreviated; every table gets `id uuid pk default gen_random_uuid()`,
`created_at timestamptz default now()`.

```sql
-- Identity
users        (id, auth_uid uuid, name, email, role text check (role in
              ('owner','admin','member')), active bool default true)

-- The portfolio
projects     (id, name, repo_path text, client_owned bool default false,
              client_name text, status text, archived bool default false)

-- One row per autonomous build/review run  — WRITTEN BY DOBIUS+
work_runs    (id, project_id fk, task_id fk null, lane text,        -- build|review
              stage text, model text, reviewer_model text,
              status text,                                          -- running|done|failed|blocked
              started_at, ended_at, mac_runner text)

-- Append-only event stream  — WRITTEN BY DOBIUS+
work_events  (id, run_id fk, project_id fk, kind text,              -- build_started|blocked|
              payload jsonb, event_version int default 1, at timestamptz) -- needs_approval|build_done|
                                                                          -- review_done|shiptest_done

-- Tasks  — WRITTEN BY HUB (Asana mirrored in)
tasks        (id, project_id fk, asana_gid text null, title, stage text,
              assignee fk null, priority int, blocked_reason text null)

-- Commands the Hub issues to the runner  — WRITTEN BY HUB, CONSUMED BY DOBIUS+
commands     (id, project_id fk, kind text,                         -- approve|start_task|stop_run|stop_all
              payload jsonb, status text default 'pending',         -- pending|consumed|done|rejected
              issued_by fk, consumed_at timestamptz null)

-- Comms  — WRITTEN BY BOTH
messages     (id, project_id fk, task_id fk null, thread_key text,
              author_id fk null, kind text,                         -- human|agent
              body text, reply_to fk null, mentions uuid[])
```

**RLS (row-level security) — the isolation guarantee:**
1. Every table scoped so a user only sees rows for projects they're a member of
   (`project_members` join, or role=owner sees all).
2. **`client_owned = true` projects publish metadata only.** Dobius+ writes status/stage to
   `work_runs`/`work_events` for them but **never code, diffs, or transcript content**, and
   even that is gated behind a per-project `publish_enabled` flag that stays OFF for
   axiom/elysium until the **client-data legal review** clears (see §6).
3. `commands` insert allowed only for role in (owner, admin); `stop_*` always allowed
   (safety).
4. The event schema is **versioned + additive-only** (`event_version`) so an older Hub
   degrades instead of breaking.

---

## 4. Phase plan (detailed)

### PHASE 0 — Foundation & contract  *(critical path — everything gates on this)*
**Goal:** a live Supabase that is the shared bus, with auth, the contract schema, proven
RLS isolation, and a decided migration boundary.

Tasks:
- **0.1** Create the Supabase project (org-owned). Enable Auth, Postgres, Realtime.
- **0.2** Write migration #1 (the §3 schema) + `project_members` join table.
- **0.3** Write RLS policies (§3) and a `publish_enabled` flag per project.
- **0.4** **Secrets boundary:** secrets stay in Dobius+ local config; **never** in Supabase.
  Write it down as policy. The bridge auth key lives in a local env file, untracked.
- **0.5** **config.json migration map:** decide field-by-field what becomes shared
  (projects, tasks, work runs, messages) vs. stays local (accounts, API keys, tab/scrollback
  state, terminal state). Document.
- **0.6** Seed real projects with `client_owned` flags (axiom/elysium = true,
  `publish_enabled = false`).
- **0.7** **Membership/permission graph FIRST.** Before everything else, model `clients`,
  `memberships(user, scope_type, scope_id, role)`, and personas — the Access Explorer,
  isolation, chat ACLs, and onboarding all depend on it. This is the true first artifact.
- **0.8** **Environments:** stand up separate dev / staging / prod Supabase projects.
- **0.9** **Agent principals (machine IAM):** give agents scoped identities capped below their
  dispatcher (never client-prod, never cross-client) in the same RLS model.
- **0.10** **Migration & parallel-run plan:** how today's `config.json` data moves into the
  foundation, and how old Dobius+ runs alongside the new system during cutover without losing
  live data.

**Deliverables:** `supabase/migrations/0001_contract.sql`, an ERD, written secrets +
migration policy.
**Verify / exit:** two test users sign in; RLS blocks a cross-project read in a query test;
a `client_owned` project is invisible to a non-member.

---

### PHASE 1 — Dobius+ outbound bridge + Hub skeleton
**Goal:** Dobius+ publishes work-state to Supabase and consumes commands; the Hub shell
shows live project status end-to-end.

**Dobius+ side (new `electron/supabase-bridge.js`):**
- **1.1** Add `supabase-bridge.js` — a scoped Supabase client; key from local env. One module,
  no secrets committed. Includes a **local outbox** (`better-sqlite3`) that buffers events and
  replays on reconnect, so a Supabase outage never loses a `work_event`.
- **1.2** Hook `work-registry.js` (`registerWork` / `markDone` / `handleTabExit`) to **also**
  upsert `work_runs` + insert `work_events`. Reuses the existing observability hooks — minimal
  new surface.
- **1.3** Hook `tasks-service.js` / `task-pipeline.js` stage transitions → emit `work_events`
  (`build_started`, `blocked`, `needs_approval`, `build_done`, `review_done`, `shiptest_done`).
- **1.4** **Command consumer:** subscribe to `commands` (Realtime); handle `approve` /
  `start_task` / `stop_run` / `stop_all` by calling existing functions (`auto-mode` dispatch,
  `gracefulCloseTerminals`, `killAll`). **Respect the existing human gates** — a Hub `approve`
  satisfies the same gate, it does not bypass it.
- **1.5** Project mapping: Dobius project paths ↔ Supabase `projects.id`. Honor
  `publish_enabled` (skip publishing for client projects until cleared).

**Hub side (new repo):**
- **1.6** Scaffold: Vite + React + TS + Tailwind v4 + shadcn/ui + Supabase client + auth screen.
- **1.7** App shell: sidebar (Acme look via 21st.dev), routing, single window, theme.
- **1.8** Projects list + project detail: read `projects` + latest `work_runs`; live updates
  via a single Realtime subscription.
- **1.9** Status board: **group-by-stage** across all projects (the borrowed pattern).

**Deliverables:** `supabase-bridge.js`, the Hub repo, working auth + live status.
**Verify / exit:** trigger a real build in Dobius+ → the run and its events appear **live** in
the Hub; issue an `approve` from the Hub → it satisfies the gate in Dobius+.

---

### PHASE 2 — Multi-project organization (the dashboard side)
**Goal:** the Hub becomes a real portfolio command center.

- **2.1** Portfolio home: per-project health rollup (green/yellow/red from stages + blocked).
- **2.2** Cross-project task board: all `tasks` by stage; mirror Asana in (reuse
  `tasksSyncAsana` semantics; lock canonical-field ownership per the open decision).
- **2.3** Per-project page: runs, an events timeline, tasks, recent activity.
- **2.4** **Approvals queue:** all `needs_approval` events in one place → approve writes a
  gated `command`. Includes **routing, timeout, escalation, and delegation** (who owns an
  approval per client; what happens when they're asleep).
- **2.5** Team view: `users` + Realtime presence (who's online / viewing what).
- **2.6** Search across projects / tasks / events.
- **2.7** Routines surface: read `scheduled-tasks` / `auto-mode` config; show schedules.

**Deliverables:** the org + monitor UI.
**Verify / exit:** run 3 projects from one screen; approve from the Hub drives the runner;
health rollup matches reality.

---

### PHASE 3 — Communications (thread-per-work first)
**Goal:** multi-user comms wired to the work (the wedge).

- **3.1** `messages` threads per project/task: compose + list + mentions.
- **3.2** Agent events into threads: render `work_events` **inline** in the project thread
  (interleaved by default, with a "discussion only" filter). *(Revisit the dismissed
  comms-shape question if you want a separate feed instead.)*
- **3.3** Notifications: route to the existing **iMessage / Telegram** bridges + in-app;
  per-user prefs; throttle to avoid overload.
- **3.4** Realtime presence + typing indicators.
- **3.5** *(Deferred)* channels / DMs — gated behind the build-vs-integrate decision; thread-
  per-work ships first.

**Deliverables:** working project threads (human + agent messages).
**Verify / exit:** two users converse on a project; an agent blocker appears in-thread; the
team approves in context.

---

### PHASE 4 — Multi-model, safety, hardening, deferred modules
- **4.1** Multi-model recipe table in Dobius+ (builder ≠ reviewer model), per-project,
  **in-house projects only**. Generalize the 4 hardcoded model spots.
- **4.2** **Spend caps + global kill switch** (`stop_all` command; per-task and daily spend
  ceilings on the runner).
- **4.3** Observability: Sentry on the Hub and the Dobius+ bridge; runner health heartbeat
  surfaced in the Hub.
- **4.4** **Offboarding / access revocation** flow (deactivate user → RLS cuts access).
- **4.5** *(Only if still wanted)* thin read-only Calendar / Customers / Finance modules.
- **4.6** **Analytics/reporting layer:** per-client throughput, capacity/overload, and **agent
  ROI** (cost vs. work shipped), fed by the activity spine.
- **4.7** **Quality gate as data:** surface `ship-test` + cross-model review results in the Hub
  per run — the "no bugs" north star, made visible.
- **4.8** **Runner-incident runbook:** if the runner Mac is lost/compromised, the exact
  secret-rotation order + notifications.

---

## 5. Cross-cutting workstreams (run across all phases)

| Workstream | Rule |
|---|---|
| **Confidentiality** | Client projects publish metadata-only, `publish_enabled` OFF until legal clears. Enforced in RLS, not UI. |
| **Secrets** | Local-only in Dobius+. Never in Supabase. |
| **Auth & roles** | owner / admin / member; offboarding deactivates + revokes. |
| **Cost** | Spend caps + kill switch land before heavy autonomous use. |
| **Observability** | Sentry + health heartbeat from Phase 1's bridge onward. |
| **The contract** | Versioned, additive-only. Schema changes are a deliberate, reviewed event. |

---

## 6. Open decisions to resolve BEFORE Phase 0

1. **Client-data legal review** — can axiom/elysium metadata live in Supabase at all? This can
   gate those projects out of the Hub entirely. **Highest priority.**
2. **Auth method** — email/password vs. SSO (Google Workspace is already connected).
3. **Asana canonical fields** — which fields the Hub owns vs. Asana owns.
4. **Comms shape** — interleaved thread (default) vs. separate activity feed.
5. **Hub name** — currently "the Hub" placeholder.
6. **Backend lock** — Supabase recommended; confirm vs. Neon + bespoke auth.

---

## 7. Sequencing & dependencies

```
Phase 0 ──▶ Phase 1 ──┬──▶ Phase 2 ─┐
 (gates all)          └──▶ Phase 3 ─┴──▶ Phase 4 (hardening)
```
- Phase 0 and 1 are the **critical path** — nothing real is multi-user until they land.
- After Phase 1's event flow works, Phases 2 (org) and 3 (comms) can partly parallelize.
- Phase 4 hardening should not wait until the end for **spend caps + kill switch** — pull
  those forward the moment autonomous runs touch real money.

---

## 8. Success metrics (how we know it works)

- **Time-to-status:** every project's state visible at a glance in the Hub.
- **Approvals from the Hub:** gates cleared in-context, not via terminal.
- **In-context comms:** agent blockers + human discussion in the same place.
- **Event delivery:** Dobius+ events appear in the Hub in < 2s, reliably.
- **Weight:** Hub idle RAM stays low (web/Tauri, no terminals) — the original concern, met.

---

*Critical path reminder: the whole plan hinges on Phase 0 (the foundation/contract). Build
that first, prove the Phase 1 event flow end-to-end, then everything else hangs off it.*

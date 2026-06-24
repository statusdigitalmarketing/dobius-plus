# Dobius+ Hub — Architecture Blueprint

> **Status:** DESIGN DOC. Date: 2026-06-22. Companions: `DOBIUS-BUSINESS-OS-MASTER-PLAN.md`
> (vision/architecture), `DOBIUS-HUB-BUILD-PLAN.md` (phased build), `BUSINESS-OS-PLAN.md`
> (research). This doc covers the enterprise dimensions: infra, data, security, reliability,
> ops.

---

## 0. Scope & honest right-sizing (read first)

This system is an **internal business OS for a small team (3+ internal users, no client
logins)** with **one autonomous runner on a Mac**. It is **not** a public, millions-of-user
SaaS, and pretending otherwise would lead to expensive over-engineering. So this blueprint
designs for the **real** load and characteristics:

- **Concurrency:** tens of users at most, single-digit concurrent autonomous builds.
- **"Zero downtime" applies to the Hub/foundation, not the runner.** A single Mac runner is
  a deliberate, accepted single point of failure. The design's job is to make the runner's
  downtime **non-fatal** (the Hub stays fully usable, builds queue) — not to eliminate it.
- **Scale path is documented, not pre-built.** Each section ends with "if it ever needs to
  scale" so the seams exist without paying hyperscale cost today.

Where the generic enterprise checklist genuinely matters here: **security, data isolation,
audit, and compliance** — because the clients (axiom/elysium) are healthcare-adjacent. Those
sections are treated at full enterprise weight. The hyperscale-infra sections are treated at
right-sized weight with a scale path.

**Design target update — "eventually 50, per client."** The target has moved from "3+
internal" to *eventually a ~50-person internal company, organized per client.* That is
**department-scale, not consumer-scale** (still no multi-region, no microservices, no custom
gateway). What it changes vs. the original right-sizing: (1) the single Mac runner becomes a
**runner fleet** (a must at 50, not a scale-path option); (2) **integrate** human chat
(Slack), don't build it; (3) a real **org + IAM layer** (client hierarchy, membership matrix,
SSO, access governance) becomes load-bearing. Design these seams now; build incrementally.

---

## 1. Core System Design

### 1.1 Topology — three actors

```
        ┌──────────────── FOUNDATION (Supabase, cloud) ────────────────┐
        │  Auth · Postgres (RLS) · Realtime · Storage · Edge Functions │
        └──────▲───────────────────────────────────────────▲──────────┘
               │ read/write (RLS-scoped)                    │ publish events / consume commands
        ┌──────┴───────┐                            ┌────────┴─────────┐
        │  THE HUB      │  web (Vite/React/TS)       │   DOBIUS+        │ Electron + node-pty
        │  command +    │  Tailwind + shadcn/ui      │   the RUNNER     │ on your Mac (single)
        │  comms        │  every teammate            │   agent builds   │ holds secrets locally
        └───────────────┘                            └──────────────────┘
```

- **The Hub** (control plane): portfolio organization + team comms. Stateless web client.
- **Dobius+** (execution plane): runs agents, publishes work-state, consumes commands.
- **Supabase** (foundation): the shared bus + contract. Neither app calls the other directly.

### 1.2 Technology stack

| Concern | Choice | Rationale |
|---|---|---|
| Hub UI | Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui | 21st.dev components drop in natively |
| Hub host | Vercel (web), Tauri wrapper later | Already a Vercel shop; lightest delivery |
| Foundation | Supabase (Postgres 15 + Auth + Realtime + RLS + Storage) | Auth + data + realtime + isolation in one |
| Runner | Existing Electron + node-pty + better-sqlite3 | Keep Dobius+ as-is; add only an outbound bridge |
| Eventing | Postgres tables + Supabase Realtime (CDC over WebSocket) | The event/command contract |
| Errors | Sentry (already standard across the portfolio) | Consistency |
| Notifications | Existing iMessage + Telegram bridges | Reuse, don't rebuild |
| Tasks upstream | Asana (hybrid sync) | Keep the system of record where it earns it |

### 1.3 Scalability patterns (right-sized + scale path)

- **Today:** Supabase handles the data/realtime fan-out; the Hub is stateless and CDN-served;
  the runner is capped (`work-registry` `maxConcurrentAgents`). This comfortably serves the
  real load.
- **Scale path → now a design target ("eventually 50, per client").** At ~50 internal users
  the single Mac runner is no longer acceptable as the company build engine, so it becomes a
  **runner fleet**: multiple always-on runners behind a project-keyed job queue. The seam
  already exists (the runner only needs outbound to Supabase), so it stays relocatable — but
  at 50 it is a **must-build, not an option**. The Hub + Supabase tier still scales without
  multi-region or microservices; 50 internal users is department-scale.

### 1.4 Performance & optimization

- Hub: route-level code splitting, list virtualization, a single shared Realtime channel
  (Broadcast for high-frequency, Presence for slow state), `better-sqlite3`/IndexedDB local
  cache for instant loads.
- Runner: keep heavy PTY buffers in the daemon, unmount idle xterm views (see master plan
  Part 4), concurrency cap bounds peak RAM.
- Target: Hub interaction < 100ms p95; event Dobius+ → Hub < 2s.

---

## 2. Infrastructure & Deployment

- **Cloud:** Supabase (single primary region — pick US-East to match Vercel; **data
  residency is a compliance decision, see §5**). Vercel edge for the Hub.
- **Regions/AZs/DR:** Supabase provides managed Postgres with automated backups + PITR on
  paid tiers. **DR posture:** RPO ≈ minutes (PITR), RTO ≈ restore time. A single region is
  appropriate at this scale; multi-region is explicitly *not* warranted.
- **Containerization:** the Hub is serverless (Vercel) — no containers needed. The runner is
  a desktop app. *Scale path:* if the runner moves to a VM, containerize it (Docker) so the
  PTY host is reproducible — but launch agents inside the container at non-root (node-pty
  runs at parent permission).
- **CI/CD:**
  - Hub: GitHub Actions → typecheck + lint + Vitest + Playwright → preview deploy on PR →
    promote to prod on merge (Vercel).
  - Dobius+: existing path — Vite build + `electron-builder` (signed/notarized) → GitHub
    Releases auto-update.
  - **DB migrations:** versioned SQL in `supabase/migrations`, applied via CI with review;
    additive-only to protect the inter-app contract.
- **Environments:** separate **dev / staging / prod** Supabase projects. Schema and contract
  changes are tested in staging against seed data before prod — you cannot evolve a database
  50 people depend on against live data. Cheap to set up now, painful to retrofit.
- **Observability:** Sentry (Hub + runner bridge), Supabase logs/metrics, a **runner health
  heartbeat** row the Hub watches (so "runner offline" is visible, not silent). Structured
  logs with request/run correlation IDs.

---

## 3. Data Architecture

- **Primary store:** Supabase Postgres. Schema = the contract (`users`, `projects`,
  `work_runs`, `work_events`, `tasks`, `commands`, `messages`) — see build plan §3.
- **Caching:** Hub local cache (IndexedDB) for offline reads; runner keeps `better-sqlite3`
  local. No Redis needed at this scale (Supabase Realtime covers fan-out).
- **Data flow:** event-sourced-lite — Dobius+ appends `work_events` (immutable), updates
  `work_runs`; the Hub writes `tasks`/`commands`/`messages`; both subscribe via Realtime.
  Asana sync is one-way intake + a defined canonical-field map for two-way.
- **Backup & recovery:** Supabase automated daily backups + PITR; export critical tables to
  cold storage weekly. Local `config.json` (secrets) backed up via the Mac's encrypted
  Time Machine, **never** to the cloud DB.
- **Security & encryption:** TLS in transit everywhere; Supabase encrypts at rest. **Secrets
  never enter Postgres** (local-only in Dobius+). PII minimization in `messages`.
- **Org & client hierarchy (per-client organization):** client is first-class —
  `clients ──< projects ──< (tasks · work_runs · threads · assets)`, with `teams` + people
  assigned across clients/projects. **`client_id` on every relevant row** — each client is a
  tenant boundary; shared-schema + RLS.
- **Membership is a matrix, not a tree:** `memberships(user, scope_type, scope_id, role)` —
  scope = client | project | team | global. A person is in a department *and* across several
  clients *and* projects, each with a role. This graph must be **computable + explainable**
  (it powers the Access Explorer, §5.A).
- **One activity/event spine:** chat, work, deploy, calendar, and approval events flow through
  a single typed `events` model rather than per-feature plumbing — the backbone that makes
  comms + org + monitoring feel like one product. CQRS-lite: read models (unread counts,
  feeds, dashboards) are separated from the write path.

---

## 4. API & Integration Design

- **API style:** primarily **event-driven** (the command/event contract over Realtime) plus
  Supabase's auto-generated REST/RPC for CRUD. No bespoke API server needed — Supabase +
  Edge Functions cover it. Heavier logic (e.g., command validation) goes in Edge Functions
  or Postgres functions with RLS.
- **AuthN/AuthZ:** Supabase Auth (JWT). **Authorization is RLS** — every row scoped by
  project membership + role (owner/admin/member). This is the core security control, enforced
  in the database, not the UI.
- **Rate limiting / throttling:** Supabase platform limits + per-user limits in Edge
  Functions; the runner has its own concurrency caps and (to add) **spend caps** so a runaway
  agent can't burn money or flood events.
- **Third-party integrations:** Asana (tasks), iMessage/Telegram (notifications), OpenRouter
  (multi-model, in-house projects only), Sentry, plus GitHub (PR/CI), Render/Vercel (deploys),
  Stripe (revenue). Ingest via **inbound webhooks → Edge Function → the activity spine** (push,
  not poll). All keys stay server/runner-side; failures degrade gracefully (queue + retry,
  never crash the Hub).
- **Chat architecture (at team scale):** Realtime is the *live* layer, not the source of truth
  (it does not guarantee delivery) — the durable `messages` table + a per-user `last_read`
  cursor is truth, with catch-up on reconnect. Model a unified `conversations(type, scope,
  members)` primitive (work-thread | channel | DM) so DMs/channels can be added without a
  rewrite. Conversation-level ACL inherits from client/org scope (a Client-A channel is
  invisible outside Client A). A **notification routing engine** (prefs, mentions, DND, digest,
  escalation) sits over the existing iMessage/Telegram/Slack bridges. Chat is treated as
  **records** (retention, export, redaction, legal hold) for the healthcare-adjacent clients.

---

## 5. Security & Compliance  *(full enterprise weight — this is where it matters)*

- **Layers:** network (TLS, Supabase platform), application (JWT auth, input validation,
  the existing control-char stripping on attacker-controllable Asana content), data
  (**RLS row isolation + encryption at rest**).
- **The isolation guarantee (the most important control):** `axiom-connect` and
  `elysium-connect` must never cross-contaminate. Enforced by **RLS project scoping**, and
  client projects publish **metadata only** behind a `publish_enabled` flag that stays OFF
  until cleared. Code/diffs/transcripts of client work do **not** enter the shared DB.
- **Compliance:** clients are healthcare-adjacent with a 7-year immutable audit vault.
  **Open blocker:** confirm client contracts/DPAs permit their project data (even metadata)
  in Supabase, and whether Supabase must be a named subprocessor. This can gate axiom/elysium
  out of the Hub — resolve before Phase 0.
- **Audit logging:** an append-only `audit_log` (who approved a deploy, who issued a command,
  who read what) — required for a team touching client work. The `task-pipeline` event model
  is the seed.
- **Vulnerability management:** Dependabot/`npm audit` in CI; pin + review native modules;
  no secrets in any repo (existing house rule, enforced by a pre-commit secret scan).
- **Access control:** least privilege roles; **offboarding deactivates a user → RLS instantly
  revokes** all access. Service keys scoped and rotatable.

---

## 5.A Access Governance, Identity & Onboarding (IAM)

The human face of the authz model — and a **compliance requirement, not just UX**, given
healthcare-adjacent clients ("demonstrate who had access to client data and when").

**Access Explorer (super-admin / admin surface)** — answers "who can access what," both ways:
- **By person** → every client, project, app/integration, file/asset, channel, and role they reach.
- **By resource** → everyone who can reach a given project / client / integration / file, and at what level.
- Shows **effective** access (direct grants + group/department inheritance + role) **and why**
  ("inherited from Axiom team → Reviewer"). Requires the membership graph (§3) to be introspectable.
- **Integrations are governed resources:** who may use GitHub-push / Render-deploy /
  Stripe-revenue / Sentry lives in the same matrix, not a free-for-all.

**Confidentiality conflict detection (segregation of duties)** — the Explorer actively **flags
or blocks** anyone who would gain access to **both** `axiom` and `elysium`, turning the #1
isolation rule from "hope" into an enforced, visible guardrail. Generalizes to any
client-pair conflict policy.

**Onboarding (provisioning made easy):**
- **Personas / access bundles** — "Engineer on Client A," "Account Manager," "Reviewer" bundle
  the right scoped memberships + integration access + default channels; assign the persona →
  it all provisions at once. The biggest lever for fast onboarding.
- **SSO just-in-time provisioning** from Google Workspace; **group → persona sync**.
- **Onboarding checklist/state** so no member is left half-connected.
- **Self-service access requests** → admin approval → logged.
- **Offboarding is the symmetric mirror:** one action deprovisions everything (RLS cascade).

**Governance requirements this implies:** (1) the permission model is **computable +
explainable**, not just enforced; (2) **personas** are first-class (not atomic roles);
(3) **access requests + approvals** are a logged workflow; (4) **access reviews /
recertification** run periodically; (5) **policy guardrails** (the axiom/elysium conflict) are
enforced + surfaced; (6) **everything is audit-logged**, and the Explorer reads from that log.
All six hang off the §3 membership graph — making it **the first Phase 0 deliverable**.

**Agents are principals too (machine IAM).** Autonomous agents get their **own** identities
and scoped permissions in the same membership/RLS model — and are always **capped below** the
human who dispatched them. Hard ceilings: an agent **never deploys to a client's prod
autonomously** and **never crosses a client boundary**. An agent's reach = (dispatcher's
scope) ∩ (agent-persona limits), enforced in RLS and audited like any other principal.

---

## 6. Code Organization & Standards

- **Repos:** Dobius+ (existing), the Hub (new), shared **contract package** (`@dobius/contract`
  — the TypeScript types + event schema both apps import, so the contract can't drift).
- **Hub structure:** `app/` (routes), `components/ui` (shadcn), `components/` (feature),
  `lib/` (supabase client, hooks), `types/` (from contract pkg).
- **Standards:** TypeScript strict; ESLint + Prettier; the house bans (no empty catch,
  no `@ts-ignore`, CSS variables for color, no hardcoded paths). Conventional commits.
- **Testing:** Vitest (unit), React Testing Library (components), Playwright (E2E across the
  Hub↔Supabase↔runner-stub flow). The runner already has a pure-module test pattern
  (`task-pipeline.test.js`) to follow. Target: the contract layer and RLS policies get the
  highest coverage (they're the risk).
- **Docs:** the contract package is self-documenting types; an ADR log for architectural
  decisions; per-phase deliverables in `plans/`.

---

## 7. Reliability & Resilience

- **The honest truth:** with a **single Mac runner, true zero-downtime of execution is not
  achievable** — and that's an accepted tradeoff. The design makes downtime **non-fatal**:
  - **Graceful degradation:** the Hub reads/writes Supabase independently of the runner. If
    the Mac is asleep/offline, the team still sees state, talks, and plans; **commands and
    builds simply queue** (`commands.status = pending`) and drain when the runner returns.
  - **Failover (scale path):** the runner is relocatable to an always-on VM; a second runner
    can be added behind the project-keyed queue for real failover. Not built now.
- **Load balancing:** Vercel edge for the Hub; Supabase manages DB connections (pooler). At
  this scale no app-tier LB is needed.
- **Service recovery:** the runner reconciles on startup (re-reads pending commands, resumes
  in-flight work via the existing graceful-close/resume-id mechanism); Realtime auto-reconnects
  with backoff; idempotent event writes (dedupe on `run_id`+`kind`+`at`) survive retries.
- **Durability both directions:** if the *foundation* blips, the runner buffers events in a
  **local outbox** (`better-sqlite3`) and replays on reconnect (idempotent), so no `work_event`
  is lost during a Supabase outage. If the *runner* is down, commands queue in Postgres and
  drain on its return. Neither side losing data is the resilience guarantee.

---

## 8. DevOps & Operations

- **Deployment & rollback:** Hub — Vercel immutable deploys, instant rollback to a prior
  deployment; DB — forward-only migrations with a tested down-path for the last migration.
  Dobius+ — GitHub Releases with the ability to pin a prior version.
- **Configuration management:** Hub config via Vercel env; runner secrets local-only;
  feature flags in a `settings` table (e.g., `publish_enabled` per project).
- **Resource & cost optimization:** Supabase paid tier (right-sized, not enterprise);
  **model-spend caps + a global kill switch** (`stop_all`) so autonomous runs can't run away;
  Vercel hobby/pro is sufficient. Track model spend per project in the existing cost tracker.
- **On-call & incident response (realistic for a small team):** Sentry alerts → the existing
  Telegram/iMessage bridges. A short runbook: "runner offline" (restart the Mac daemon),
  "Supabase degraded" (Hub read-only banner, builds queue), "runaway agent" (`stop_all` from
  the Hub). The kill switch is the most important operational control — build it early.

---

## 9. The five things this blueprint says NO to (anti-over-engineering)

1. **No multi-region / global replication** — one region fits the team; revisit only with real geographic users.
2. **No Kubernetes** — the Hub is serverless; the runner is a desktop app. Containers only if the runner ever leaves the Mac.
3. **No microservices** — two apps + a managed backend is the right granularity; splitting further adds ops cost with no benefit.
4. **No bespoke API gateway / Redis / message broker** — Supabase Realtime + tables are the bus at this scale.
5. **No custom auth** — Supabase Auth + RLS; never hand-roll identity.

---

*Bottom line: design for the team you have with seams for the scale you might earn. The
enterprise rigor goes into security, isolation, audit, and compliance — because the clients
are healthcare-adjacent — and the hyperscale infrastructure is deliberately deferred behind
documented seams, not pre-built.*

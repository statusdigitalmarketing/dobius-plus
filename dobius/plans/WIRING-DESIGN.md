# Wiring Design — Asana → Crew → verify → draft-back

Turning the standalone Crew platform into a working operation: Asana tasks flow to agents,
agents act through in-process tools (no shell), results come back as draft comments you approve.
Synthesis of three research passes (2026-07-08): internal seam map, ticket-pipeline SOTA, and a
107-agent adversarially-verified deep-research run. Full reports in session transcript.

## What the research settled (verified, high-confidence)

1. **Routing is deterministic, never a classifier.** The verified finding across Copilot/Jules/
   Linear: NO shipping system uses an AI triage agent to decide *which* worker handles a ticket —
   routing is always rules (assignee/label). LLM judgment is only for *how* (brief assembly,
   task decomposition). → Our assignee-GID lanes (Carson=build, Sam=review) ARE the router.
   A "Triage agent" writes the brief and picks the skill; it does not decide the lane.
2. **Brief is a frozen snapshot at claim time.** Snapshot title+notes+comments into a structured
   brief; do NOT re-read the ticket mid-run (later comments = a new turn). Copilot literally
   ignores post-assignment comments.
3. **Ack-first cadence, ack = claim lock.** Write the draft ack the instant a task is claimed;
   an existing agent ack on a task means never re-dispatch it. Progress streams to the session
   view (our run view / terminal), NOT the ticket — the ticket gets ~2 comments (ack + completion).
4. **Draft-first, agent can never mark its own work done.** Our house rule (agent drafts the Asana
   comment, human posts + completes) is stricter than market and exactly right.
5. **Edge-detection over polling-on-state.** React to a task's *transition into a lane*, not its
   presence — the fix for a 10-min poller double-firing.
6. **Prompt injection is the #1 real-world exploit of 2026** (a poisoned issue title shipped a
   malicious npm release via a claude-code-action workflow this June). Asana notes are third-party
   untrusted input. Defense is layered AND the draft-only/hard-rail gates are the layer that
   survives a *successful* injection.
7. **Not verified by any vendor → design from first principles:** idempotency/locking,
   poison-ticket backoff, per-ticket spend caps. We own these.

## Architecture — the keystone is in-process tools (no shell)

Verified in sdk.d.ts: `createSdkMcpServer` + `tool()` give agents app-powers with zero shell/fs.
A Triage agent runs `tools: []` + `mcpServers: { dobius }` + `strictMcpConfig: true` +
`allowedTools: ['mcp__dobius__*']` + `permissionMode: 'dontAsk'` → exactly our tool surface,
everything else hard-denied.

**The `dobius` in-process tool server** (new — src/main/agents/agent-tools/):
- `asana_draft_comment(gid, body)` → queues a DRAFT (never posts); lands in the decision queue /
  briefing for the human to approve+post. NEVER writes to Asana directly.
- `dispatch_build(repo, brief, agentId?)` → spins a worktree via createManagedWorktree
  (startupAgent + startupPrompt), returns the worktree/tab id.
- `read_knowledge(query|leafId)` → reads a Brain leaf (buildKnowledgeTree + safeReadFile).
- `list_crew()` / `crew_status()` → roster + live state for delegation decisions.
- `file_briefing_item(urgency, summary)` → appendBriefingItem.
Each tool is deterministic policy code — the agent proposes, the tool enforces (draft-only, path
allowlists, budget). This is the "model output is a proposal gated by deterministic checks" rule.

## The loop
Asana poll (edge-detect new-in-lane) → claim (persist gid + write draft ack) → Triage agent
(reads snapshot brief with notes SANDBOXED as untrusted, picks skill, either dispatch_build or
bounce-back-with-question if vague) → build/review run in worktree with verify pipeline
(review-audit → ship-test, bounded self-repair max 2) → asana_draft_comment with receipts
(branch, commit, gate results, screenshot) → briefing + bell → human approves & posts.

## Phases (each = codex writes, Claude reviews, install, commit)
- **W1 — in-process tool server**: `dobius` MCP server + the 5 tools (draft-only asana_draft_comment,
  read_knowledge, list_crew, file_briefing_item; dispatch_build stubbed to return "not wired yet"),
  wired into agent-runner Options.mcpServers, allowlist plumbing, per-tool policy enforcement +
  unit tests. Foundation everything else hangs on.
- **W2 — Asana read+write plumbing**: fetch `notes` (extend TASK_FIELDS); add `asanaPost` for
  POST /tasks/<gid>/stories used ONLY by the approve-and-post path (human-triggered); the
  draft store + approve/post/discard IPC + a Drafts surface on the Agents page.
- **W3 — the poller + claim/idempotency**: Asana auto-mode setInterval (copy heartbeat scheduler),
  edge-detection seen-set persisted, claim lock (ack-comment-as-lock), untrusted-notes sanitizer
  (strip HTML/invisible chars, delimited block), dead-letter after N fails + Telegram/bell alert,
  per-task budget cap. Triage agent definition + brief template.
- **W4 — build-lane dispatch + verify**: dispatch_build → createManagedWorktree live; bounded
  self-repair loop on verify-pipeline failures; receipts assembly; the full ack→work→doc→approve
  cadence end to end on one real task, human-in-the-loop.

## Guardrails (non-negotiable, enforced in tool code + hard rails)
- Asana notes sanitized + sandboxed as untrusted; triage runs minimal tool surface.
- No Asana write except via a human-approved draft (asana_draft_comment only queues).
- Worktree per task; per-task wall-clock + $ cap; idempotent claim (never double-run a gid).
- Dead-letter with full context after 2 failures (house rule) → surface, never silently retry.
- Agent never completes/closes an Asana task — human only (house rule + Copilot's golden rule).

# TASK-6 — Agent read access: `dobius manager` CLI

**Verdict:** KEEP — the pipe that makes everything else matter. Without it the
index is human-only and the "agents draw from it" thesis is prose.

## What
A `dobius manager` subcommand on the existing public dobius CLI:
- `dobius manager query [--project X] [--search "..."] [--provider gmail]`
  → JSON (default) or `--md` markdown rows (name, provider, folder, date, url,
  snippet, project/tags).
- `dobius manager projects` → project names with doc/mail counts.
Any Claude session in any terminal can then pull filed context with one command
— no MCP server, no new auth, works over the CLI's existing RPC to the app.

## Concrete simplification chosen
Rung: **reuse what's in the codebase.** The CLI already talks to the app
(terminals, worktrees, automations); this adds one command family that forwards
to the existing `ManagerBridge.query` — the same call the tab UI makes. No new
index capabilities, no daemonizing, no embeddings.

## Acceptance test
- From any terminal: `dobius manager query --project axiom-connect --md`
  prints the filed docs/threads for that project; `--search invoice` filters.
- Works while the app is running; fails with a clear "Dobius+ not running"
  message otherwise (same behavior as other dobius CLI commands).

## Estimate (rough — not measured)
~0.5–1 day (CLI plumbing + RPC forward + output shaping).

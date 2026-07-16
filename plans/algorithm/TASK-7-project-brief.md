# TASK-7 — Project brief: compiled context for minute zero

**Verdict:** KEEP — turns raw query rows into what an agent actually needs at
task start.

## What
`dobius manager brief <project>` (CLI) and `manager:brief` (IPC): compile
everything filed to a project into one markdown brief — newest mail threads
(sender, subject, snippet, link), docs grouped by folder/category (name, date,
link), tags in use, and counts. Deterministic compilation — no LLM writes it;
it's an assembly of indexed facts with links, so nothing can be hallucinated.

Consumption paths, smallest first:
1. Agent-initiated: any session runs the CLI command when its task names a
   project (one line added to the Orchestrator/teammate prompt guidance).
2. Later (own task, not this one): auto-inject the brief when a Dobius+
   terminal opens in that project — the algorithm-gate pattern, per-project.

## Concrete simplification chosen
Rung: **minimum code over existing query.** The brief is a formatter over
`ManagerBridge.query({project})` — sort, group, truncate (caps: ~20 threads,
~50 docs, snippets at 200 chars) so it fits in an agent's context cheaply.

## Acceptance test
- `dobius manager brief axiom-connect` prints a markdown brief with real filed
  items, each item carrying its open link; a project with nothing filed prints
  "nothing filed yet" (not an error).
- The brief for a busy project stays under ~4k tokens (measured by char count
  proxy, cap enforced by the truncation rules).

## Estimate (rough — not measured)
~0.5 day on top of TASK-6.

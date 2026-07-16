# TASK-9 — Auto-filing suggestions (rule-based, human-confirmed)

**Verdict:** KEEP (SIMPLIFIED) — filing must be cheap or it won't happen, and
the whole thesis (TASK-6/7) starves if nothing gets filed.

## What
Suggestions, never silent writes:
- Folder-family → project: if a family/folder name fuzzy-matches a repo
  displayName or an existing project (normalized substring match), surface
  "File 34 items → axiom-connect?" as a one-click strip (in the rail scope view
  and the TASK-8 workspace).
- Mail sender → project: if 3+ threads from the same sender are already filed
  to one project, suggest the same project for that sender's unfiled threads.
Both rules are deterministic and explainable ("suggested because the folder
name matches the repo name"), and every acceptance is one click of the existing
bulk-classify.

## What this deliberately is NOT (yet)
No LLM classification pass. Re-add trigger (from DECISIONS.md round 2) stands:
only if the deterministic rules prove too dumb on real data AND filing volume
justifies it — then a single Haiku pass over name+snippet, still
suggestion-only. Evidence gate: 2 weeks of real use of these rules first.

## Acceptance test
- With a folder family "axiom invoices…" and repo `axiom-connect`, the strip
  offers the mapping; accepting files every member (visible in By-project).
- A sender with 3 threads filed to slimject-web gets their unfiled threads
  suggested to slimject-web; accepting files them; declining leaves no trace.

## Estimate (rough — not measured)
~1 day.

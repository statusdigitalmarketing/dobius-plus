# TASK-3 — Turn classification into a real filing system (group-by + saved views)

**Verdict:** KEEP/SIMPLIFY — the classify machinery is already shipped
(`ManagerDocumentRow` inline project/category/tags; index columns
classification-owned so refresh never clobbers them). Today it's write-only
decoration: you can tag documents but can't USE the tags.

## What
- Group-by-project view (collapsible sections) and filter chips for
  project/category/tag — powered by the existing `DocumentQuery` filters
  (`dobius/src/shared/manager.ts:33-49`).
- A "views" row: All / by-Project / Untriaged (no project set), persisted as a
  simple UI preference.

## Why
Filing that can't be browsed is data entry with no payoff. This closes the loop
on code that already shipped, at UI-only cost — no backend, no IPC changes
(query filters already exist end-to-end).

## Concrete simplification chosen
Rung: **reuse what's in the codebase.** Existing `manager:query` filters +
existing Badge/Button/Select primitives from `components/ui/`. No new state
management beyond the existing filter object in `use-manager-documents.ts`.
No saved-view editor — three fixed views + the chips is the whole v1 surface.

## Acceptance test
- Tag two docs with project "X"; the by-Project view shows an "X" group
  containing exactly those docs; Untriaged shows docs with no project.
- Refresh does not clear classifications (already guaranteed by the index;
  verify in UI).

## Estimate (rough — not measured)
~0.5–1 day.

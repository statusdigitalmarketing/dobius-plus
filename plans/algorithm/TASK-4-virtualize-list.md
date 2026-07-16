# TASK-4 — Virtualize the Manager document list

**Verdict:** KEEP (perf debt found by scout) — the list renders every row in a
plain `overflow-y-auto` map (`ManagerPage.tsx:116`) while the real index holds
~598 Drive docs today and grows with Gmail (TASK-2). Also raise the query cap
(currently 200 at `use-manager-documents.ts:11`) once the list can handle it.

## What
Swap the row map for `@tanstack/react-virtual`, mirroring the existing pattern
at `dobius/src/renderer/src/components/sidebar/WorktreeList.tsx` (useVirtualizer,
plus `hooks/useVirtualizedScrollAnchor.ts` if scroll anchoring is needed).

## Why
598+ rows of non-trivial row components will jank; the dependency AND the
in-repo usage pattern already exist — this is a copy-the-pattern task.

## Concrete simplification chosen
Rung: **reuse existing dependency + in-repo pattern.** No new virtualization
lib, no windowing math by hand.

## Acceptance test
- With 500+ indexed docs, scrolling is smooth and DOM row count stays bounded
  (spot-check via devtools).
- Search/filter still work (virtualizer re-measures on filtered list).

## Estimate (rough — not measured)
~2–4 hours.

# Task 2.1 — Rewrite Sessions.jsx — project-grouped card layout

## What will change
- `src/components/Dashboard/Sessions.jsx`: Complete rewrite from table to card layout

## Why
The current Sessions tab is a basic table using the store's `sessions` (from loadHistory, limited to 100). The new Session Manager needs project-grouped cards using loadAllSessions IPC.

## Implementation
1. Replace store-based data with IPC call to `dataLoadAllSessions`
2. Group sessions by `projectName`
3. Each project group: collapsible header with project name, session count, latest timestamp
4. Each session card: preview text (truncated), relative timestamp, tag badge placeholder
5. Default: groups sorted by most recent session, sessions within group sorted by recency
6. Empty state and loading skeleton states
7. Follow styling from Checkpoints.jsx — CSS variables, ActionBtn pattern

## Verification
- `npm run build` exits 0
- Sessions tab renders with grouped layout

## What could go wrong
- loadAllSessions could be slow with many projects — add loading state
- Grouping logic could be fragile if projectName is empty — use fallback

## Estimated time
20 minutes

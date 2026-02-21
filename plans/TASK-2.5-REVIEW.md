# Task 2.5 Review — BuildMonitorView + 7th dashboard tab

## Three things that could be better
1. BuildMonitorView reads config on mount and writes on directory pick — could use a dedicated store slice, but config is simple and this follows the existing pattern.
2. The empty state shows "No Active Builds" even when a dir is selected but has no progress data — could differentiate "no dir" vs "dir but no data" more clearly. Currently handles this with a subtle note.
3. The handoff preview has a fixed maxHeight of 120px — could be adjustable, but it's a secondary info panel and scrollable.

## One thing I'm fixing right now
Nothing — the integration composes all sub-components cleanly and follows established patterns.

## Concerns
- BuildMonitorView manages its own state (projectDir) separately from the Zustand store — this is intentional since build monitoring is a side feature, not core app state.
- The "builds" tab is always visible even when no builds exist — the empty state handles this gracefully with a directory picker CTA.

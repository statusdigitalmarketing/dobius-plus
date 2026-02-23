# Task 3.2 — Session count badge on Sessions tab

## What will change
- `src/components/Dashboard/DashboardView.jsx`: Add session count state, load count on mount, display as pill badge next to Sessions tab label

## Why
Users want a quick visual indicator of how many sessions exist without having to click into the Sessions tab.

## Implementation
1. Add `useState` for sessionCount, load via `dataLoadAllSessions` IPC on mount
2. In the tab bar render, show `(N)` next to "Sessions" label when count > 0
3. Style as a small dim pill, similar to the Builds notification dot pattern

## Verification
- `npx vite build` exits 0
- `grep -c "{ id:" src/components/Dashboard/DashboardView.jsx` returns >= 12

## What could go wrong
- Must not modify the TABS array structure (gate checks tab count)
- IPC call failure should be silently handled (count stays 0)

## Estimated time
8 minutes

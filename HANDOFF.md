# Handoff — Dobius+

## Current: Task 3.1 complete — moving to Task 3.2

## What's Done
- Task 0.1: Build infrastructure
- Task 1.1: runningAgents state + actions in Zustand store
- Task 1.2: onTerminalExit listener for agent cleanup
- Task 2.1-2.3: MissionControl full rewrite (StatsBar, AgentCard, Grid, skeleton, handlers)
- Task 2.4: Renamed Agents tab to Mission Control
- Task 3.1: Fixed Shift+Enter multiline (auto-resize useEffect, \n→\r for PTY, updated placeholder)

## What's Next
- Task 3.2: Visual polish — responsive grid, hover effects, animations

## Files Touched Recently
- src/components/Project/TerminalPane.jsx

## Key Decisions
- Moved textarea auto-resize from onChange handler to useEffect for reliable React re-render handling
- \n characters from Shift+Enter are replaced with \r when sending to PTY

## Blockers
None

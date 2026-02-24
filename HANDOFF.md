# Handoff — Dobius+

## Current: Task 1.2 complete — moving to Task 2.1

## What's Done
- Task 0.1: Created feature branch build/mission-control, verify-task.sh, supervisor.sh, progress/handoff files
- Task 1.1: Added runningAgents state + registerRunningAgent/unregisterAgentsByTabId actions + cleanup in removeTab/closeOtherTabs/closeTabsToRight
- Task 1.2: Added onTerminalExit listener in ProjectView that calls unregisterAgentsByTabId for agent cleanup

## What's Next
- Task 2.1: Rewrite Agents.jsx — MissionControl layout with StatsBar (4 stat cards)

## Files Touched Recently
- src/store/store.js
- src/components/Project/ProjectView.jsx

## Key Decisions
- runningAgents cleanup happens in 4 places: removeTab, closeOtherTabs, closeTabsToRight (store), and onTerminalExit (ProjectView)
- onTerminalExit fires for all tabs, no-op for non-agent tabs

## Blockers
None

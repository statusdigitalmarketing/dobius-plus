# Task 1.2 — Add terminal exit listener for agent cleanup in ProjectView

## What will change
- `src/components/Project/ProjectView.jsx`: Add an `onTerminalExit` listener in a useEffect that calls `unregisterAgentsByTabId(termId)` when a PTY process exits

## Why
When an agent's Claude process exits naturally (user types /exit, crash, etc.), the runningAgents state needs to be cleaned up even though the tab stays open. The removeTab path handles manual close; this handles PTY exit.

## Verification
- `npx vite build` exits 0
- `grep -c 'unregisterAgentsByTabId' src/components/Project/ProjectView.jsx` returns 1

## What could go wrong
- The onTerminalExit listener API might not exist in preload — need to check
- Double-cleanup when tab is closed (removeTab already cleans up) — this is fine, unregister is idempotent

## Estimated time
8 minutes

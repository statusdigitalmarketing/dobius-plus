# Task 1.1 — Add runningAgents state and actions to Zustand store

## What will change
- `src/store/store.js`: Add `runningAgents: {}` state, `registerRunningAgent()` and `unregisterAgentsByTabId()` actions
- Modify `removeTab`, `closeOtherTabs`, `closeTabsToRight` to also clean up runningAgents

## Why
The Mission Control UI needs to show which agents are currently running (their Claude process is alive in a terminal tab). This state maps agentId → tabId so we can show status badges and enable "Chat" buttons.

## Verification
- `npx vite build` exits 0
- `grep -c 'runningAgents' src/store/store.js` returns >= 6

## What could go wrong
- Modifying existing tab removal functions could break tab closing — must preserve existing behavior exactly
- The filter logic for runningAgents cleanup must match the correct tab IDs

## Estimated time
10 minutes

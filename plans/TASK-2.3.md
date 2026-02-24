# Task 2.3 — Wire up AgentGrid and launch/chat handlers

## What will change
- Already implemented in Task 2.1's file rewrite.
- handleLaunch now calls registerRunningAgent(agent.id, tab.id)
- handleChat switches to agent's tab via setActiveTab + setActiveView('terminal')
- Agent grid uses responsive auto-fill grid
- MissionControlSkeleton provides loading state

## Verification
- `npx vite build` exits 0 (already verified)

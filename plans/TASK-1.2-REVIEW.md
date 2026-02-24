# Task 1.2 Review

## Modified
- `src/store/store.js` — added agentActivity, activityTimeline, boardNotification state + actions

## New State
- `agentActivity: {}` — Map<agentId, activity>
- `activityTimeline: []` — chronological feed (max 100)
- `boardNotification: null` — completion alerts

## New Actions
- `updateAgentActivity(agentId, activity)` — merge activity data
- `clearAgentActivity(agentId)` — remove on exit
- `appendActivityTimeline(entry)` — FIFO buffer with 100 cap
- `setBoardNotification(n)` / `clearBoardNotification()` — notification lifecycle

## Modified
- `unregisterAgentsByTabId` — now also cleans up agentActivity

## Build: PASS

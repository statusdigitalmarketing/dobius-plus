# Task 1.2: Add agentActivity state to Zustand store

## Goal
Add `agentActivity` map and `activityTimeline` array to Zustand store.

## Changes
- `src/store/store.js`: Add `agentActivity: {}`, `updateAgentActivity`, `clearAgentActivity`
- Also add `activityTimeline: []` and `appendActivityTimeline` for Task 2.3
- Modify `unregisterAgentsByTabId` to also clear agentActivity for removed agents

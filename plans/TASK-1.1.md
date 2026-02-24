# Task 1.1: Create useAgentActivity hook

## Goal
Create a custom React hook that monitors terminal output for all running agents and extracts live activity status.

## Implementation
- File: `src/hooks/useAgentActivity.js`
- Read `runningAgents` from Zustand store
- Register ONE `onTerminalData` listener (not per-tab)
- Filter incoming data by matching termId to running agent tabIds
- Strip ANSI codes from terminal output
- Parse for tool use markers: Read, Write, Edit, Bash, Grep, Glob, Task, etc.
- Detect idle (>5s no data) and completion (exit message)
- Debounce updates to 500ms to prevent render thrashing
- Write activity data to Zustand store via `updateAgentActivity` (Task 1.2)
- Track: linesProcessed, lastActivity, currentAction, startTime, status
- Clean up listener on unmount

## Key Pattern
`onTerminalData` callback receives (termId, data) — filter by checking if termId matches any running agent's tabId.

## Risk
- Multiple `onTerminalData` listeners are fine (ipcRenderer.on supports multiple)
- Must strip ANSI before parsing or regex won't match tool names

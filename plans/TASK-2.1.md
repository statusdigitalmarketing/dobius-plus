# Task 2.1: Create build-monitor data service + IPC

## What
- Create `electron/build-monitor-service.js` with async functions:
  - `loadBuildProgress(projectDir)` — reads `<projectDir>/claude-progress.json`
  - `loadSupervisorLog(projectDir)` — reads `<projectDir>/scripts/supervisor.log`, last 50 lines
  - `loadHandoff(projectDir)` — reads `<projectDir>/HANDOFF.md`
  - `detectActiveBuilds()` — uses `pgrep -lf "claude.*dangerously-skip-permissions"` to find active agents
- Wire IPC handlers in main.js + preload.js

## Files
- Create: `electron/build-monitor-service.js`
- Modify: `electron/main.js`, `electron/preload.js`

## Pattern
- Follow the same async pattern as data-service.js
- Use execFile (not exec) for process detection — safe from injection
- Validate paths before reading

## Verification
- `npx vite build` exits 0

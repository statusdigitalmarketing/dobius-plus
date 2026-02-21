# Task 2.2: Implement data-service.js (file parsing + watchers)

## What I will change
- Create `electron/data-service.js` — read all ~/.claude/ files, chokidar watchers
- Update `electron/main.js` — add IPC handlers for all data methods
- Update `electron/preload.js` — expose all data IPC methods

## Why this change is needed
The data service is the bridge between Claude Code's local files and the Dobius+ UI. It provides session history, stats, settings, plans, skills, and transcript data — all read-only.

## Functions to implement
- loadHistory() — parse ~/.claude/history.jsonl
- loadStats() — parse ~/.claude/stats-cache.json
- loadSettings() — parse ~/.claude/settings.json
- loadPlans() — list ~/.claude/plans/*.md
- loadSkills() — list ~/.claude/skills/*/
- loadTranscript(sessionId, projectPath) — read transcript JSONL
- getActiveProcesses() — ps aux | grep claude
- listProjects() — scan ~/.claude/projects/
- watchFiles(webContents) — chokidar on key files

## Verification
- App launches
- In devtools: `await window.electronAPI.dataLoadHistory()` returns sessions array
- `await window.electronAPI.dataLoadStats()` returns stats object
- NO writes to ~/.claude/ (grep check)

## What could go wrong
- JSONL parsing failures on malformed lines
- Large history files causing slowness
- chokidar watcher path resolution on macOS

## Estimated time
25-30 minutes

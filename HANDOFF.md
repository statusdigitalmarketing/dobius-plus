# Handoff — Dobius+

## Current: Task 2.2 DONE — Moving to Task 3.1

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps
- Task 1.2: terminal-manager.js with node-pty backend, IPC handlers
- Task 1.3: TerminalPane + useTerminal hook — xterm.js connected to node-pty via IPC
- Task 2.1: 10 dark themes ported from themes.sh, ThemePicker with color swatches, CSS variables
- Task 2.2: data-service.js — read-only ~/.claude/ parsing, IPC handlers, chokidar watchers

## What's Next
- Task 3.1: Implement ProjectView layout with TopBar, StatusBar, sidebar area

## Blockers
None

## Key Decisions
- All data methods are READ-ONLY — verified zero writes to ~/.claude/
- Used execFile instead of execSync for getActiveProcesses (security)
- chokidar watchers on history.jsonl and stats-cache.json with awaitWriteFinish
- JSONL parsing skips malformed lines silently (expected for partial writes)
- Transcript loading tries direct path first, then scans all project dirs as fallback

## Files Touched Recently
- electron/data-service.js (new — 270+ lines)
- electron/main.js (updated with data IPC handlers + watchFiles)
- electron/preload.js (updated with data IPC methods)

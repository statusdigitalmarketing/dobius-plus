# Handoff — Dobius+

## Current: Task 1.2 DONE — Moving to Task 1.3

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps installed, Vite build passes
- Task 1.2: terminal-manager.js with node-pty backend, IPC handlers, preload exposure

## What's Next
- Task 1.3: Implement TerminalPane component (xterm.js frontend) — connect xterm.js to node-pty via IPC

## Blockers
None

## Key Decisions
- Feature branch: `build/dobius-plus-v1`
- Electron ESM for main process, CJS for preload (Electron limitation)
- terminal:write and terminal:resize use ipcRenderer.send (fire-and-forget) for performance
- terminal:create uses ipcRenderer.invoke (returns pid)
- onTerminalData/onTerminalExit return cleanup functions

## Files Touched Recently
- electron/terminal-manager.js (new)
- electron/main.js (updated with IPC handlers + before-quit)
- electron/preload.js (updated with terminal IPC)

# Task 1.2: Implement terminal-manager.js (node-pty backend)

## What I will change
- Create `electron/terminal-manager.js` — node-pty session manager with create/write/resize/kill/killAll
- Update `electron/main.js` — add IPC handlers for terminal operations, before-quit cleanup
- Update `electron/preload.js` — expose terminal IPC methods to renderer

## Why this change is needed
The terminal backend is the core of Dobius+ — it manages real pseudo-terminal sessions that the xterm.js frontend will connect to in Task 1.3.

## Verification
- App launches without crash
- In devtools console: `window.electronAPI.terminalCreate('test', '/tmp')` succeeds
- Terminal process spawns (check `ps aux | grep zsh`)

## What could go wrong
- node-pty not properly rebuilt for Electron (runtime crash)
- IPC channel naming conflicts
- pty cleanup on window close missing → zombie processes

## Estimated time
15-20 minutes

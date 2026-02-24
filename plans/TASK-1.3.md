# Task 1.3: Expose Memory APIs in Preload + Auto-Capture on Agent Exit

## What
1. Add 6 agentMemory API methods in preload.js
2. Extend onTerminalExit listener in ProjectView to auto-capture journal entries when agent terminals exit

## Why
- Preload exposes IPC bridge for renderer to access memory
- Auto-capture provides passive run logging without user action

## Verification
- `npx vite build` exits 0
- `grep -c 'agentMemory' electron/preload.js` returns 6

## Risks
- Journal entry won't have terminal output summary (no scrollback access from exit handler) — acceptable for v1

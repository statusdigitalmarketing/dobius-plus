# Task 1.3 — Wire IPC handlers + preload for sessions + tags

## What will change
- `electron/main.js`: Add IPC handlers in setupDataHandlers() and setupConfigHandlers()
  - `data:loadAllSessions` → loadAllSessions()
  - `data:getLatestSession` → getLatestSession(projectPath)
  - `config:getSessionTags` → getSessionTags()
  - `config:setSessionTag` → setSessionTag(sessionId, label, color)
  - `config:removeSessionTag` → removeSessionTag(sessionId)
- `electron/preload.js`: Add corresponding electronAPI methods

## Why
The renderer needs IPC access to the new data-service and config-manager functions.

## Verification
- `npm run build` exits 0
- All existing IPC still works (dashboard loads, sessions load, config saves)

## What could go wrong
- Import collision if function names overlap — unlikely, names are unique
- Forgetting to import new functions in main.js

## Estimated time
8 minutes

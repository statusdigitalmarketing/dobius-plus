# Task 3.3 — Cmd+R keyboard shortcut to resume last session

## What will change
- `src/components/Project/ProjectView.jsx`: Add `r` key handler in the keyboard shortcuts useEffect

## Why
Power users want a fast way to resume their last Claude session without clicking through the UI.

## Implementation
1. In the existing `handleKeyDown` function in ProjectView.jsx, add a case for `e.key === 'r'`:
   - Call `dataGetLatestSession(projectPath)` IPC
   - If session found, call `resumeSession(sessionId)` from the store
   - If not found, do nothing silently
2. Must not conflict with browser Cmd+R reload (Electron's default menu strips this in production)

## Verification
- `npx vite build` exits 0

## What could go wrong
- Cmd+R might still trigger page reload in dev mode — acceptable since Electron strips it in production
- Need to import `resumeSession` from store (already available since Task 2.4)
- Async IPC call in a keyboard handler is fine — just need to not preventDefault if we don't handle it

## Estimated time
8 minutes

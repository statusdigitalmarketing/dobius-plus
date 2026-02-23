# Task 2.4 — One-click resume from session card

## What will change
- `src/store/store.js`: Add `resumeSession` action
- `src/components/Dashboard/Sessions.jsx`: Add Resume and Open Project buttons to SessionCard

## Why
Users need to resume a session directly from the Sessions dashboard without manually typing the resume command.

## Implementation
1. Add `resumeSession(sessionId)` to Zustand store:
   - Calls `setActiveView('terminal')`
   - Sends `claude --resume <sessionId>` to active terminal using char-by-char 5ms delay pattern
2. Add "Resume" button to each session card
3. Add "Open Project" button that calls `windowOpenProject(session.projectPath)` if different from current project
4. Use existing `useStore` patterns from Checkpoints.jsx and Agents.jsx

## Verification
- `npm run build` exits 0

## What could go wrong
- Session ID validation — must only allow safe chars (alphanumeric + hyphens)
- If no active terminal tab, the resume command has nowhere to go

## Estimated time
12 minutes

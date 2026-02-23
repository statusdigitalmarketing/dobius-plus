# Review — Task 2.4: One-click resume from session card

## Changes
- `src/store/store.js`: Added `resumeSession(sessionId)` action
  - Validates sessionId with `/^[\w-]+$/` regex (security: prevents command injection)
  - Switches to terminal view, sends `claude --resume <id>` char-by-char at 5ms intervals
  - Matches existing char-by-char pattern from TerminalPane.jsx
- `src/components/Dashboard/Sessions.jsx`: Added Resume + Open buttons to SessionCard
  - Resume button (accent styled) calls `resumeSession(sessionId)` via Zustand store
  - Open button (conditional) appears when session is from a different project
  - Added `CardBtn` reusable button component with hover effects
  - `isDifferentProject` check compares `currentProjectPath` from store

## Security
- Session ID validated with strict regex before interpolation into command string
- No shell execution — uses terminalWrite character-by-character

## Build
- `npx vite build` passes: 1,311KB bundle

## Risk
- If no active terminal tab, resume silently does nothing (acceptable UX)
- Different-project resume types into current terminal — user expected to use "Open" for cross-project

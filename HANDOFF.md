# Handoff — Dobius+

## Current: Task 3.2 DONE — Moving to Task 3.3

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps
- Task 1.2: terminal-manager.js with node-pty backend, IPC handlers
- Task 1.3: TerminalPane + useTerminal hook — xterm.js connected to node-pty via IPC
- Task 2.1: 10 dark themes ported from themes.sh, ThemePicker with color swatches, CSS variables
- Task 2.2: data-service.js — read-only ~/.claude/ parsing, IPC handlers, chokidar watchers
- Task 3.1: ProjectView layout with TopBar, StatusBar, sidebar area, Zustand store
- Task 3.2: Sidebar with search, ConversationCards, Preview panel, Resume button

## What's Next
- Task 3.3: Implement pin persistence + config storage in ~/Library/Application Support/Dobius/

## Blockers
None

## Key Decisions
- Sidebar has search, pinned section, recent section
- Double-click conversation to open Preview (transcript viewer)
- Resume writes `claude --resume <id>` directly to terminal via IPC
- Pin state is local for now — will persist in Task 3.3

## Files Touched Recently
- src/components/Project/Sidebar.jsx (new)
- src/components/Project/ConversationCard.jsx (new)
- src/components/Project/Preview.jsx (new)
- src/hooks/useSessions.js (new)
- src/lib/time-ago.js (new)
- src/components/Project/ProjectView.jsx (updated with Sidebar integration)

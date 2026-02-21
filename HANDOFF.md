# Handoff — Dobius+

## Current: Task 3.3 DONE — Moving to Task 4.1

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps
- Task 1.2: terminal-manager.js with node-pty backend, IPC handlers
- Task 1.3: TerminalPane + useTerminal hook — xterm.js connected to node-pty via IPC
- Task 2.1: 10 dark themes ported from themes.sh, ThemePicker with color swatches, CSS variables
- Task 2.2: data-service.js — read-only ~/.claude/ parsing, IPC handlers, chokidar watchers
- Task 3.1: ProjectView layout with TopBar, StatusBar, sidebar area, Zustand store
- Task 3.2: Sidebar with search, ConversationCards, Preview panel, Resume button
- Task 3.3: Config persistence — pins, themes, window bounds in ~/Library/Application Support/Dobius/

## What's Next
- Task 4.1: Implement 6-tab Dashboard (Overview, MCP, Skills, Stats, Sessions, Plans)

## Blockers
None

## Key Decisions
- Config stored at ~/Library/Application Support/Dobius/config.json (Electron userData)
- Debounced save (500ms) for window bounds
- Per-project theme index saved to config
- Pinned sessions saved to config.pinnedSessions array

## Files Touched Recently
- electron/config-manager.js (new)
- electron/main.js (updated with config IPC + window bounds save)
- electron/preload.js (updated with config IPC)
- src/components/Project/ProjectView.jsx (updated with config load/save)

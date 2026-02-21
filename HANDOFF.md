# Handoff — Dobius+

## Current: Task 4.2 DONE — Moving to Task 4.3

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
- Task 4.1: 6-tab Dashboard — Overview, MCP Servers, Skills, Stats, Sessions, Plans + useStats hook
- Task 4.2: Multi-window support — window-manager.js, per-project BrowserWindows, IPC

## What's Next
- Task 4.3: Implement Launcher window (project grid, open project windows)

## Blockers
None

## Key Decisions
- projectWindows Map tracks open project windows
- Each project window gets its own file watchers and terminal sessions
- Window bounds saved per-project to config
- Terminal IDs prefixed with project path for cleanup on close

## Files Touched Recently
- electron/window-manager.js (new)
- electron/main.js (updated with window IPC + closeAllProjectWindows)
- electron/preload.js (updated with window IPC)

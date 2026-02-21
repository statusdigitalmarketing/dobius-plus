# Handoff — Dobius+

## Current: Task 5.1 DONE — Moving to Task 5.2

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
- Task 4.3: Launcher window — ProjectList grid with search, ProjectCard, App.jsx routing
- Task 5.1: Build pipeline — electron-builder, DMG, build-and-install.sh

## What's Next
- Task 5.2: Polish — keyboard shortcuts + error handling

## Blockers
None

## Key Decisions
- 512x512 icon minimum required by electron-builder
- Ad-hoc signing for dev builds (no Apple Developer ID)
- DMG output to dist-electron/
- build-and-install.sh handles kill/remove/mount/copy/open cycle

## Files Touched Recently
- build/icon.png (new — 512x512 placeholder)
- electron-builder.yml (new)
- build-and-install.sh (new, executable)

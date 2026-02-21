# Handoff — Dobius+

## Current: Task 3.1 DONE — Moving to Task 3.2

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps
- Task 1.2: terminal-manager.js with node-pty backend, IPC handlers
- Task 1.3: TerminalPane + useTerminal hook — xterm.js connected to node-pty via IPC
- Task 2.1: 10 dark themes ported from themes.sh, ThemePicker with color swatches, CSS variables
- Task 2.2: data-service.js — read-only ~/.claude/ parsing, IPC handlers, chokidar watchers
- Task 3.1: ProjectView layout with TopBar, StatusBar, sidebar area, Zustand store

## What's Next
- Task 3.2: Implement conversation Sidebar with search, preview, resume functionality

## Blockers
None

## Key Decisions
- Zustand store for global state (activeView, sidebarVisible, themeIndex, sessions, etc.)
- TopBar: sidebar toggle + Terminal/Dashboard buttons (left), project name (center), ThemePicker (right)
- StatusBar: session count + active processes (left), version (right)
- ProjectView: flex layout with sidebar (280px) + content area

## Files Touched Recently
- src/store/store.js (new)
- src/components/shared/TopBar.jsx (new)
- src/components/shared/StatusBar.jsx (new)
- src/components/Project/ProjectView.jsx (new)
- src/App.jsx (simplified to render ProjectView)

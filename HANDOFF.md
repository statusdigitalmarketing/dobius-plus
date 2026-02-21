# Handoff — Dobius+

## Current: Task FINAL.2 DONE — Ready for merge

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
- Task 5.2: Polish — keyboard shortcuts (Cmd+T/B/K/N), ErrorBoundary, app menu
- Task FINAL.1: Self-review via code-reviewer + code-explorer subagents
- Task FINAL.2: Fixed critical watcher bug, config flush on quit, DMG error check

## What's Next
- Task FINAL.3: Merge to main

## Blockers
None

## Key Decisions
- Per-window watcher Map instead of global singleton (fixes multi-window updates)
- flushConfig() called synchronously in before-quit to prevent data loss
- URL encoding is consistent: Electron loadFile handles production, encodeURIComponent handles dev

## Files Touched Recently
- electron/data-service.js (fixed: per-window watcher Map)
- electron/config-manager.js (added: flushConfig export)
- electron/main.js (added: flushConfig import + call in before-quit)
- build-and-install.sh (added: DMG existence check)
- SELF-REVIEW-FINDINGS.md (new)

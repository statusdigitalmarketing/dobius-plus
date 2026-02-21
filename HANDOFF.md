# Handoff — Dobius+

## Current: Task 2.1 DONE — Moving to Task 2.2

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps
- Task 1.2: terminal-manager.js with node-pty backend, IPC handlers
- Task 1.3: TerminalPane + useTerminal hook — xterm.js connected to node-pty via IPC
- Task 2.1: 10 dark themes ported from themes.sh, ThemePicker with color swatches, CSS variables

## What's Next
- Task 2.2: Implement data-service.js — read ~/.claude/ files, IPC, chokidar watchers

## Blockers
None

## Key Decisions
- THEMES array exported from src/lib/themes.js with xtermTheme + cssVars
- applyTheme() sets CSS variables on document.documentElement
- ThemePicker uses circular swatches with glow on active theme
- makeXtermTheme derives bright colors using lighten() function
- Theme persistence deferred to Task 3.3

## Files Touched Recently
- src/lib/themes.js (new)
- src/components/shared/ThemePicker.jsx (new)
- src/App.jsx (updated with theme state + ThemePicker)

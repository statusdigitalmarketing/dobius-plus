# Handoff — Dobius+

## Current: Task 1.1 DONE — Moving to Task 1.2

## What's Done
- Task 0.1: Pre-flight validation, feature branch, infrastructure files
- Task 1.1: Electron + Vite + React scaffold with all deps installed, Vite build passes

## What's Next
- Task 1.2: Implement terminal-manager.js (node-pty backend) — IPC handlers for terminal:create/write/resize/kill

## Blockers
None

## Key Decisions
- Feature branch: `build/dobius-plus-v1`
- Electron ESM for main process, CJS for preload (Electron limitation)
- Tailwind CSS v4 with @tailwindcss/vite plugin
- CSS variables for theming: --bg, --fg, --accent, --border, --surface, --dim
- trafficLightPosition: { x: 12, y: 12 } for macOS title bar

## Files Touched Recently
- package.json, vite.config.js, index.html
- electron/main.js, electron/preload.js
- src/main.jsx, src/App.jsx, src/styles/index.css

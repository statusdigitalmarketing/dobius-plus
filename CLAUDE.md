# Dobius+ — Multi-Window Claude Code Desktop App

## Overview
Dobius+ is an Electron desktop app that wraps Claude Code CLI in themed terminal windows. Each project gets its own window with an embedded terminal (xterm.js + node-pty), conversation history sidebar, and dashboard tabs.

## Tech Stack
- **Electron 33+** — desktop shell, multi-window, IPC
- **Vite 6 + React 19** — renderer UI
- **xterm.js + @xterm/addon-fit + @xterm/addon-web-links** — terminal emulation
- **node-pty** — pseudo-terminal backend
- **Zustand** — state management
- **Tailwind CSS 4** — styling
- **chokidar** — file watchers

## Architecture
- **Main process** (`electron/`): window management, node-pty sessions, file parsing, IPC
- **Renderer** (`src/`): React app with terminal panes, sidebar, dashboard
- **Multi-window**: each project gets its own BrowserWindow, project ID passed via URL query param
- **Themes**: 10 dark themes ported from `claude-terminal/themes.sh`, applied per window

## Data Sources (read-only, local files)
- `~/.claude/history.jsonl` — session index
- `~/.claude/projects/<encoded>/<sessionId>.jsonl` — transcripts
- `~/.claude/stats-cache.json` — daily stats
- `~/.claude/settings.json` — hooks, MCP servers, plugins
- `~/.claude/plans/*.md` — plan files
- `~/.claude/skills/` — installed skills

## Key Commands
```bash
npm run electron:dev     # Dev mode (Vite + Electron)
npm run build            # Build Vite frontend
npm run electron:build   # Build .app bundle
./build-and-install.sh   # Build + install to /Applications
```

## Reference Code
- Gmail Dashboard Electron patterns: `../gmail-mcp/desktop-app/electron/main.js`
- Claude Terminal themes: `../claude-terminal/themes.sh`

## Important Notes
- `node-pty` requires native compilation — use `electron-rebuild` after install
- macOS: `titleBarStyle: 'hiddenInset'` for frameless native look
- Dev: Vite on localhost:5173, Electron loads URL. Prod: Electron loads `dist/index.html`
- Config persistence: `~/Library/Application Support/Dobius/config.json`
- `build-and-install.sh` MUST `rm -rf` old .app before `cp -R` (asar overwrite issue)
- **NEVER use null bytes (`\x00`) in `execFile` arguments** — Node.js throws `ERR_INVALID_ARG_VALUE`. Use a text separator like `||SEP||` instead (see `git-service.js` commit log format).
- **Dev process name is "Electron"**, not the app name. Use `tell process "Electron"` in AppleScript during dev; the display name only applies to packaged `.app` builds.
- **Remote debugging**: `app.commandLine.appendSwitch('remote-debugging-port', '9222')` in main.js enables CDP for Playwright/testing. Remove before shipping.
- **Git tab needs project context**: `GitView` reads `currentProjectPath` from the Zustand store (set by `ProjectView`). The launcher window has no project path, so Git tab only works in project windows.

## Keyboard Shortcuts (Project Window)
- `Cmd+T` — toggle Terminal / Dashboard
- `Cmd+B` — toggle left sidebar
- `Cmd+G` — toggle Git side panel (terminal view only)
- `Cmd+K` — clear terminal

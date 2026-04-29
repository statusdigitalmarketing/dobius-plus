# Dobius+ — Multi-Window Claude Code Desktop App

## Overview
Dobius+ is an Electron desktop app that wraps Claude Code CLI in themed terminal windows. Each project gets its own window with multi-tab terminals (xterm.js + node-pty), session checkpoints, custom agents, CLAUDE.md editor, conversation history sidebar, and dashboard tabs.

## Tech Stack
- **Electron 33+** — desktop shell, multi-window, IPC
- **Vite 6 + React 19** — renderer UI
- **xterm.js + @xterm/addon-fit + @xterm/addon-web-links** — terminal emulation
- **node-pty** — pseudo-terminal backend
- **Zustand** — state management
- **Tailwind CSS 4** — styling
- **chokidar** — file watchers
- **react-markdown + remark-gfm** — CLAUDE.md live preview

## Architecture
- **Main process** (`electron/`): window management, node-pty sessions, file parsing, IPC
- **Renderer** (`src/`): React app with terminal panes, sidebar, dashboard
- **Multi-window**: each project gets its own BrowserWindow, project ID passed via URL query param
- **Multi-tab terminals**: Chrome-style tab bar, all tabs stay mounted (CSS display:none) to preserve xterm buffer + PTY
- **Tab ID format**: `term-${projectPath}-${counter}` — extends existing scheme, window-manager cleanup via prefix match
- **Themes**: 10 dark themes ported from `claude-terminal/themes.sh`, applied per window

## Multi-Tab Architecture
- Tab state in Zustand: `terminalTabs[]`, `activeTabId`, `tabCounter`
- Each tab gets its own `<TerminalPane>` with unique terminal ID
- Tabs persist to `config.projects[path].tabs` + `config.projects[path].tabCounter`
- Terminal scrollback persists to `config.projects[path].terminalStates[tabId]`
- Migration: old single `terminalState` key still loads for backward compat

## Checkpoints
- Save terminal scrollback as named checkpoints: `config.projects[path].checkpoints[]`
- IPC: `checkpoint:save`, `checkpoint:list`, `checkpoint:delete`, `checkpoint:rename`
- Restore: writes checkpoint scrollback as dimmed text to active terminal
- Fork: creates new tab with checkpoint data pre-loaded via `terminalSaveState`

## Custom Agents
- Built-in starters: Code Reviewer, Bug Hunter, Refactor Assistant, Test Writer
- User-created agents stored in `config.settings.agents[]`
- Launch = create new tab + write `claude --system-prompt-file /tmp/dobius-agent-*.txt`
- System prompt written to temp file (safer than shell-escaping)
- IPC: `agents:list`, `agents:save`, `agents:delete`, `agents:getBuiltins`, `agents:writeTempPrompt`

## CLAUDE.md Editor
- Split view: textarea editor + live markdown preview (react-markdown + remark-gfm)
- File list discovers: `project/CLAUDE.md`, `project/.claude/CLAUDE.md`, `~/.claude/CLAUDE.md`
- Security: only files named exactly `CLAUDE.md` can be read/written. 1MB content limit
- IPC: `file:read`, `file:write`, `file:listClaudeMd`

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
npm run electron:build   # Build .app bundle (signed + notarized when APPLE_* env vars set)
./build-and-install.sh   # Build + install to /Applications
```

## Releasing
See `RELEASING.md` for the full signed/notarized publish workflow (auto-update via GitHub Releases).

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
- **All tabs stay mounted (CSS display:none)** — unmounting kills xterm buffer + PTY
- **Agents use temp file for system prompt** — safer than shell-escaping arbitrary text
- **CLAUDE.md file access is allowlisted** — only files named `CLAUDE.md` can be read/written

## Keyboard Shortcuts (Project Window)
- `Cmd+T` — new terminal tab
- `Cmd+W` — close tab (won't close window if last tab)
- `Cmd+1-9` — switch to tab N
- `Cmd+Shift+[` — previous tab
- `Cmd+Shift+]` — next tab
- `Cmd+Shift+T` — reopen last closed tab (terminal view) / toggle Terminal↔Dashboard (dashboard view)
- `Cmd+B` — toggle left sidebar
- `Cmd+G` — toggle Git side panel (terminal view only)
- `Cmd+K` — clear terminal
- `Cmd+F` — search terminal
- `Cmd+S` — save (CLAUDE.md editor)
- `Cmd+Q x2` — quit (press twice)

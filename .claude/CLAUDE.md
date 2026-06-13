# Dobius+ — Claude Workflow Layer

> **Read order for any session:**
> `~/.claude/CLAUDE.md` (global house rules) → `~/Projects (Code)/CLAUDE.md` (workspace) → `../CLAUDE.md` (project ROOT — canonical architecture) → this file.
>
> This file is the thinnest layer. It adds only the Claude-workflow context the root file lacks. Global rules always win.

---

## What this is

Dobius+ is in-house tooling: an Electron desktop app that wraps the Claude Code CLI in themed, multi-tab terminal windows (dashboard, checkpoints, custom agents, CLAUDE.md editor, voice-conductor wiring, cost tracker, iMessage bridge). The **root `CLAUDE.md` is canonical** for architecture and the Electron gotchas. Do not duplicate it here — look there first:

| Need to know about... | Root CLAUDE.md section |
|---|---|
| Tech stack, main/renderer split, multi-window model | Tech Stack / Architecture |
| Multi-tab terminals (mounting, tab IDs, persistence) | Multi-Tab Architecture |
| Checkpoints (save/restore/fork, IPC) | Checkpoints |
| Custom agents (built-ins, temp-prompt launch, IPC) | Custom Agents |
| CLAUDE.md editor (allowlist, 1MB limit, IPC) | CLAUDE.md Editor |
| Read-only data sources (`~/.claude/*`) | Data Sources |
| Key commands + release flow | Key Commands / Releasing |
| Electron gotchas (null bytes, process name, rm -rf, tab mounting, Git tab) | Important Notes |
| Keyboard shortcuts | Keyboard Shortcuts |

Per-account Claude CLI path (`account.cliPath`) is wired in `electron/config-manager.js`; voice-conductor lives in `electron/voice-conductor.js` + `voice-bridge.js`.

---

## Current build status (verify before building)

- **Version:** `1.0.22` (package.json). Latest commit `d082675` adds per-account CLI path on top of the 1.0.22 tag.
- **Working tree is dirty — 26 uncommitted files.** Review these before starting new work; a new session should not assume a clean tree.

**Modified (20):**
`AUTONOMOUS-BUILD.md`, `electron/data-service.js`, `electron/data-utils.js`, `electron/preload.js`, `electron/voice-bridge.js`, `electron/window-manager.js`, `package-lock.json`, `src/components/Dashboard/DashboardView.jsx`, `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`, `src/components/Dashboard/Overview.jsx`, `src/components/Dashboard/Sessions.jsx`, `src/components/Dashboard/Settings.jsx`, `src/components/Dashboard/Skills.jsx`, `src/components/Launcher/ProjectCard.jsx`, `src/components/Launcher/ProjectList.jsx`, `src/components/Project/ProjectView.jsx`, `src/components/Project/TerminalPane.jsx`, `src/components/Project/TerminalTabBar.jsx`, `src/components/shared/StatusBar.jsx`, `src/components/shared/TopBar.jsx`, `src/store/store.js`

**Untracked (6):**
`electron/file-change-service.js`, `src/components/Dashboard/ChangeFeed.jsx`, `src/components/Dashboard/Costs.jsx`, `src/components/Dashboard/Prompts.jsx`, `src/components/Dashboard/Search.jsx`, `src/components/Launcher/ProjectContextMenu.jsx`

This looks like an in-flight feature (dashboard Costs/Prompts/Search/ChangeFeed + a file-change service). Confirm intent with the user before committing or branching over it.

---

## Real npm scripts (package.json)

```bash
npm run dev              # Vite dev server only
npm run build            # Vite frontend build
npm run build:mobile     # Vite build with vite.mobile.config.js (mobile PWA)
npm run electron:dev     # concurrently: Vite + wait-on + electron .
npm run electron:build   # vite build + mobile build + electron-builder --mac
npm start                # electron . (no Vite)
./build-and-install.sh   # build, quit running app, rm -rf old .app, install to /Applications
```

Note: `electron:build` now also runs the **mobile** build before `electron-builder`. The root file's command list predates `build:mobile` — trust this list for the real script set.

---

## Project done-bar additions (on top of global Done Bar)

- **Run on a feature branch**, never on `main` (global rule). Local-first: do not push / open PRs / trigger GitHub Releases unless the user explicitly asks.
- **`npm run build` must exit 0** before any commit (no `tsc` — this is a JS/Vite project).
- **After dependency changes:** native modules need rebuild — `electron-rebuild` is in the tree (`node-pty`, `better-sqlite3` are native). Rebuild before launching or the app will fail to load the PTY/SQLite addon.
- **`build-and-install.sh` must keep its `rm -rf` of the old `.app`** before copying (asar overwrite issue) — do not "optimize" that step away.
- **Remove any `remote-debugging-port` switch before shipping** (CDP for Playwright/testing). It is NOT currently in `electron/main.js` — keep it that way for release builds.
- **Test in a project window, not the launcher** — the Git tab and project-scoped views need `currentProjectPath` from the store, which the launcher window does not set.

---

## Critical rules — reference only (see root Important Notes)

These are documented in full in the root `CLAUDE.md`. One line each as a reminder:

- **Null bytes:** never pass `\x00` to `execFile` args — use `||SEP||` (see `git-service.js`).
- **Dev process name is `"Electron"`**, not `Dobius+` — use it in AppleScript during dev.
- **`build-and-install.sh` rm -rf** the old `.app` before `cp -R` — asar overwrite.
- **All terminal tabs stay mounted (CSS `display:none`)** — unmounting kills the xterm buffer + PTY.
- **Config persists at `~/Library/Application Support/dobius-plus/config.json`** (Electron userData = package name `dobius-plus`, NOT `Dobius`) — do NOT hand-edit; set via in-app Settings (`config-manager.js` owns the atomic write).

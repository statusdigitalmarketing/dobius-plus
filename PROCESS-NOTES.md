# Process Notes — Dobius+
Architecture observations, goal alignment analysis, and suggestions.

## Architecture Summary (Phase 1 Read-Through)

### Structure
- 33 source files total (electron/ + src/)
- **Main process** (6 files): main.js, preload.js, terminal-manager.js, data-service.js, window-manager.js, config-manager.js
- **Renderer** (27 files): React 19 + Zustand + Tailwind 4, organized by feature (Launcher, Project, Dashboard, shared)
- **No test suite** exists

### Module Architecture
1. **main.js** — App lifecycle, IPC handler registration, menu setup, window creation
2. **preload.js** — contextBridge with 22+ IPC channels (terminal, data, config, window)
3. **terminal-manager.js** — node-pty session CRUD with Map-based registry
4. **data-service.js** — Read-only ~/.claude/ file parsing (JSONL, JSON, directory listing), chokidar watchers with per-webContents cleanup
5. **window-manager.js** — Multi-window registry (projectPath → BrowserWindow), bounds persistence
6. **config-manager.js** — Debounced JSON persistence to ~/Library/Application Support/Dobius/, flushConfig on quit

### Key Patterns Observed
- **IPC pattern**: preload.js exposes typed API, main process uses ipcMain.handle (invoke/return) for data, ipcMain.on (fire-and-forget) for terminal input
- **State management**: Zustand store for UI state, React hooks (useTerminal, useSessions, useStats) for data loading + watcher subscriptions
- **Theme system**: 10 themes as objects with CSS variable generation + xterm theme + color swatches
- **Error handling**: try/catch with console.warn in most electron modules; ErrorBoundary component in renderer
- **Config persistence**: Debounced writes with synchronous flush on before-quit
- **Multi-window**: URL query param (`?project=`) determines if Launcher or ProjectView renders

### Initial Impressions

**What looks solid:**
- Clean separation of concerns between main/renderer
- Good use of contextBridge with contextIsolation
- Debounced config saves with flush-on-quit is a good pattern
- Per-webContents watcher cleanup avoids memory leaks
- Proper ResizeObserver + debounced fit in useTerminal

**What looks risky:**
- `preload.js` referenced in main.js line 38 — but the build prompt said `preload.cjs` originally. File actually exists as `preload.js` (CommonJS with require syntax, but .js extension). This may cause issues with ESM-configured package.json (`"type": "module"`)
- `data-service.js:263` — Path decoding uses naive `-` → `/` replacement, which will mangle paths containing literal hyphens (e.g., `/Users/john/my-project`)
- `Plans.jsx` — `handleExpand` loads config instead of reading plan file content (no readFile IPC exists). Shows metadata instead of actual markdown content.
- `useTerminal.js` — theme is in useEffect dependency array for the main effect (line 131), but there's a separate theme-only effect. The eslint-disable comment suppresses this — may cause unnecessary re-renders or double terminal creation if theme object reference changes.
- `window-manager.js:78` — terminal cleanup on window close uses string prefix matching (`term-${projectPath}`) which could match unintended terminals if paths are prefixes of each other.

### Goal Alignment First Pass

| Goal | Status | Notes |
|------|--------|-------|
| 1. Themed terminal windows per project | ✅ Implemented | Full xterm.js + node-pty with per-project windows |
| 2. Embedded terminal + sidebar + dashboard | ✅ Implemented | ProjectView has all three |
| 3. Dashboard tabs (overview, MCP, skills, stats, sessions, plans) | ✅ Implemented | All 6 tabs present |
| 4. 10 dark themes with persistence | ✅ Implemented | THEMES array, ThemePicker, config persistence |
| 5. Multi-window support | ✅ Implemented | window-manager.js, per-project BrowserWindows |
| 6. Read-only ~/.claude/ data access | ✅ Implemented | data-service.js parses all mentioned files |
| 7. Production build → installable .app | ✅ Implemented | electron-builder.yml, build-and-install.sh |

All 7 stated goals have supporting code. No significant scope creep detected.

### Estimated Codebase Health (Before Formal Audit)
Estimated: **75-85/100 (Good)** — Clean architecture, but has some bugs in path handling, a non-functional Plans content viewer, and no test coverage.

# Dobius+ — Autonomous Build Prompt (v5)

## Launch Command (Preferred — with supervisor auto-resume)
```bash
cd "/Users/statusmacbook2024/Projects (Code)/dobius-plus"
bash scripts/crackbot-supervisor.sh AUTONOMOUS-BUILD.md
```

## Launch Command (Manual — no auto-resume)
```bash
cd "/Users/statusmacbook2024/Projects (Code)/dobius-plus"
claude --dangerously-skip-permissions -p "$(cat AUTONOMOUS-BUILD.md)"
```

## Resume After Context Death (if not using supervisor)
```bash
# Resume the most recent session (preserves full conversation context):
claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists, read it too. Resume from the current task."

# Or resume a specific session by ID (printed at session start):
claude --dangerously-skip-permissions --resume <session-id> -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists, read it too. Resume from the current task."
```

## Morning Verification (check results after overnight run)
```bash
git log --oneline -40                         # Should have ~13 commits (one per task)
cat SELF-REVIEW-FINDINGS.md 2>/dev/null       # Should show all [x] checked off (or not exist)
cat HANDOFF.md | head -5                      # Should say BUILD COMPLETE
npx tsc --noEmit 2>/dev/null || echo "No TS"  # Zero type errors (if TS configured)
npm run build 2>&1 | tail -5                  # Vite build succeeds
ls src/components/**/*.jsx 2>/dev/null | wc -l # Should be >= 15 components
cat claude-progress.json | head -20           # See current state
cat scripts/supervisor.log 2>/dev/null        # Check restart count
```

---

# STEP 0 — Read Lessons Learned (MANDATORY)

If `LESSONS-LEARNED.md` exists in the project root, read it NOW before doing anything else. It contains mistakes from prior builds — patterns to avoid, detection commands, and fixes. Every lesson is a rule you must follow.

If it doesn't exist, check for `LESSONS-LEARNED-TEMPLATE.md` in the project root or parent directory. If found, copy it to `LESSONS-LEARNED.md` and read the seed lessons.

---

# PREAMBLE — What You're Working On

## The Project
Dobius+ is a multi-window Electron desktop app that embeds Claude Code CLI in themed terminal windows. Each project gets its own window with a real terminal (xterm.js + node-pty), conversation history sidebar, and dashboard monitoring tabs. Think of it as a premium IDE wrapper for Claude Code.

## What Already Exists
This is a FRESH project — only `CLAUDE.md`, `.gitignore`, and this build file exist. You are building from scratch. However, you MUST reference these existing codebases for patterns:
- **Gmail Dashboard Electron app** at `../gmail-mcp/desktop-app/` — Electron + Vite + React patterns, IPC, preload, build scripts
- **Claude Terminal themes** at `../claude-terminal/themes.sh` — 10 dark theme color definitions to port

## Critical Rule: NEVER modify ~/.claude/ files — read-only access only
The codebase is at `/Users/statusmacbook2024/Projects (Code)/dobius-plus`. The app reads from `~/.claude/` to display session history, stats, and settings. It must NEVER write to, delete from, or modify any file in `~/.claude/`. All app config goes in `~/Library/Application Support/Dobius/`.

---

# GLOBAL RULES — Read These Before Every Task

## The Micro-Task Cycle

Every single task follows this exact cycle. No exceptions. No shortcuts.

```
PLAN -> IMPLEMENT -> VERIFY -> REVIEW -> COMMIT -> GATE -> LOG
```

### Step 1: PLAN
Before writing any code for task N.N, create `plans/TASK-N.N.md` with:
- What you will change (specific files and functions)
- Why this change is needed
- What the test/verification will look like
- What could go wrong
- Estimated time

This file MUST exist before you write a single line of implementation code.

### Step 2: IMPLEMENT
Write the code. Follow the existing patterns exactly (see Architecture Reference below).

### Step 3: VERIFY
Run the task's specific verification command(s). The expected output is listed in each task. If the output doesn't match, the task is NOT done — fix it.

Minimum verification for EVERY task:
```bash
# For tasks that add JSX/JS files, verify no syntax errors:
node -e "try { require('acorn').parse(require('fs').readFileSync('src/App.jsx','utf8'), {ecmaVersion:2022, sourceType:'module', plugins:{jsx:true}}); console.log('OK') } catch(e) { console.log('SYNTAX ERROR:', e.message); process.exit(1) }" 2>/dev/null || echo "Skipping syntax check"
# After Task 1 sets up Vite:
npm run build 2>&1 | tail -3   # Must succeed
```

**Auto-append lessons learned**: If verification fails 2 or more times on the same task, you MUST append the failure pattern to `LESSONS-LEARNED.md` before moving on:
```markdown
## Lesson: <short title>
- **Build**: Dobius+ Phase 1
- **Task**: N.N
- **What went wrong**: <description>
- **Root cause**: <why it happened>
- **Fix**: <what fixed it>
- **Detection**: `<command to detect this pattern>`
- **Prevention**: <how to avoid this in future>
```

### Step 4: REVIEW
After implementing, re-read every file you changed. Write `plans/TASK-N.N-REVIEW.md` with:
1. Three things that could be better
2. One thing you're fixing right now (then fix it)
3. Any concerns about the approach

### Step 5: COMMIT + HANDOFF
```bash
git add -A && git commit -m "Task N.N: <one-line description>"
```

**MANDATORY**: Immediately after committing, update `HANDOFF.md` with:
- Add this task to "What's Done" with a one-line summary
- Update "What's Next" to the next task number
- Update "Files touched recently" with the files you just changed

This is NON-NEGOTIABLE. If context crashes and HANDOFF.md is stale, the restarted agent wastes 20+ minutes re-orienting. HANDOFF.md is your save game — save after every task.

### Step 6: GATE
```bash
bash scripts/verify-task.sh N.N
```
This script MUST exit with code 0 before you start the next task. If it fails, fix the issues and re-run.

### Step 7: LOG
Append to `BUILD-LOG.md`:
```
## Task N.N — <title>
- Start: HH:MM
- End: HH:MM
- Duration: X min
- Files changed: list
- Verification: PASS/FAIL (attempts: N)
```

---

## Explicit Bans

These patterns are BANNED. The verify-task.sh script checks for them. If any are found, the task fails.

### In Source Code
| Pattern | Why It's Banned | Detection |
|---------|----------------|-----------|
| Empty catch blocks | Silently swallows errors | `grep -rPc 'catch\s*(\(\w+\))?\s*\{\s*\}' src/` must be 0 |
| `catch { return }` | Same | `grep -rPc 'catch.*\{\s*return\s*[^;]*;?\s*\}' src/` must be 0 |
| `console.log` for errors | Use proper error handling | `grep -rc 'console\.log.*error\|console\.log.*err' src/` must be 0 |
| Writing to ~/.claude/ | CRITICAL — read only | `grep -rc 'writeFile.*\.claude\|fs\.write.*\.claude\|unlink.*\.claude' src/ electron/` must be 0 |

## Time Guard

After completing each task, check the duration. If any task completed in less than 8 minutes, you MUST write a self-critique in the review file:

> "This task completed in X minutes, which is suspiciously fast. Self-check:
> - Did I actually test this, or just write code that looks right?
> - Did I read the files I changed back after writing them?
> - What did I skip that I should have done?"

## Git Discipline

- **Feature branch**: All work happens on `build/dobius-plus-v1`. NEVER commit directly to main during the build.
- Commit after EVERY task (not every phase)
- Commit message format: `Task N.N: <description>`
- Never go more than 30 minutes without a commit
- **WIP commits**: Before any risky or long operation (complex refactor, multi-file rename, large test rewrite), commit current work first:
  ```bash
  git add -A && git commit -m "WIP: Task N.N — about to <risky thing>"
  ```
  If the risky operation succeeds, the next task commit supersedes this. If context dies mid-operation, the WIP commit preserves your progress and the supervisor will auto-resume from here.
- If context compresses mid-task: commit work-in-progress immediately with `WIP: Task N.N`

## Context Preservation

Maintain these files throughout the build:

### `claude-progress.json`
```json
{
  "current_phase": 1,
  "current_task": "1.3",
  "tasks_completed": ["0.1", "1.1", "1.2"],
  "tasks_remaining": ["1.3", "1.4", "1.5"],
  "last_commit": "abc1234",
  "last_updated": "2026-02-10T12:00:00Z",
  "build_start": "2026-02-10T10:00:00Z",
  "build_branch": "build/dobius-plus-v1",
  "verification_failures": {},
  "notes": ""
}
```

### `HANDOFF.md` (CRITICAL — update after EVERY commit)
This is your lifeline when context crashes. A stale HANDOFF.md = 20+ minutes wasted on reorientation. Update it in Step 5 of EVERY task cycle. Contains:
- **What's done**: List of ALL completed tasks with one-line summaries
- **What's next**: The exact next task number and what it requires
- **Blockers**: Anything preventing progress
- **Key decisions**: Important architectural choices made during the build
- **Files touched recently**: Last 3-5 files modified (so you can re-read them)

### `SELF-REVIEW-FINDINGS.md` (created during Final Phase)
Written by subagent reviewers. Contains checklist of findings. Main agent fixes each one and marks `[x]`. If context dies during fix phase, restarted agent reads this file and continues from unchecked items.

### `BUILD-LOG.md`
Append-only log of every task with timing, files changed, and verification results.

### When Context Compresses (you feel lost or can't remember earlier work)
1. Read `HANDOFF.md` first — it's the most concise summary
2. Read `claude-progress.json` — machine-readable state
3. If `SELF-REVIEW-FINDINGS.md` exists, check for unchecked items — you may be in the fix phase
4. Run `git log --oneline -20` — see what was committed
5. Run `npm run build 2>&1 | tail -5` — verify nothing is broken
6. Read `BUILD-LOG.md` — detailed history
7. Re-read the current phase section below

## Startup Sequence (Run at EVERY Context Window Start)

```bash
#!/bin/bash
echo "=== Dobius+ — Session Init ==="
pwd
git branch --show-current
git log --oneline -10
cat claude-progress.json 2>/dev/null || echo "No progress file"
cat HANDOFF.md 2>/dev/null || echo "No handoff file"
if [ -f SELF-REVIEW-FINDINGS.md ]; then echo "--- SELF-REVIEW FINDINGS ---"; grep '\- \[ \]' SELF-REVIEW-FINDINGS.md; fi
npm run build 2>&1 | tail -5
echo "=== Finding next task ==="
```

If progress file exists, resume from the last incomplete task. If not, start from Task 0.1.

## Subagent Strategy

Use subagents (the Task tool) for parallelizable work when appropriate:
- **Parallel verification**: Run build check in one subagent while linting in another
- **Code exploration**: Delegate "read and summarize the Gmail Dashboard Electron app" to an Explore subagent
- **Independent phases**: If two tasks have zero dependencies, run them simultaneously
- **Self-review** (Final Phase): Launch code-reviewer + code-explorer subagents to audit the build

Do NOT use subagents for:
- Sequential tasks where order matters
- Tasks that modify the same files
- The gate script (always run in the main context)

## MCP Servers Available

None required for this build. The app reads local files only.

---

# ARCHITECTURE REFERENCE — Read Before Writing Any Code

## FIRST TASK: Read These Files
Before writing a single line of code, you MUST read every one of these files cover-to-cover:

| File | Why |
|------|-----|
| `CLAUDE.md` | Project overview, tech stack, architecture, important notes |
| `../gmail-mcp/desktop-app/electron/main.js` | Electron main process patterns — window creation, IPC handlers, child process management |
| `../gmail-mcp/desktop-app/electron/preload.js` | Context bridge pattern for IPC |
| `../gmail-mcp/desktop-app/vite.config.js` | Vite config for Electron (`base: './'`) |
| `../gmail-mcp/desktop-app/package.json` | Scripts pattern: dev, electron:dev, build, electron:build |
| `../gmail-mcp/desktop-app/build-and-install.sh` | Build + DMG install script (MUST rm -rf old app before cp) |
| `../gmail-mcp/desktop-app/electron-builder.yml` | electron-builder config for macOS DMG |
| `../claude-terminal/themes.sh` | 10 dark theme definitions to port (bg, fg, cursor, accent1-4) |
| `~/.claude/history.jsonl` (tail -5) | Session index format (sessionId, project, display, timestamp) |
| `~/.claude/stats-cache.json` | Stats format (dailyActivity, modelUsage, hourCounts) |
| `~/.claude/settings.json` | Settings format (hooks, mcpServers, enabledPlugins) |

## Dependencies
**Already installed:** None (fresh project)
**You need to install:**
```bash
npm init -y
npm install react react-dom zustand chokidar
npm install -D electron electron-builder vite @vitejs/plugin-react tailwindcss @tailwindcss/vite concurrently wait-on
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
npm install node-pty electron-rebuild
npx electron-rebuild  # Rebuild node-pty for Electron's Node version
```

**CRITICAL**: `node-pty` is a native module. After installing, you MUST run `npx electron-rebuild` to compile it for Electron's Node.js version. If you skip this, the terminal will crash at runtime.

---

# PHASE 0 — Setup & Pre-Flight (Task 0.1)

## Task 0.1: Pre-Flight Validation + Create Infrastructure
**Action**: Validate the environment is sane, create the feature branch, and initialize build infrastructure.

### Pre-Flight Checks (run ALL before doing anything else)
```bash
# 1. Git must be clean
git status --porcelain | wc -l  # Must be 0 — if not, stash or commit first

# 2. Node/npm available
node --version   # Must be >= 18
npm --version

# 3. Electron available after install
npx electron --version 2>/dev/null || echo "Will install"

# 4. Disk space check
df -h . | tail -1               # Warn if < 5GB free
```

If ANY pre-flight check fails, FIX IT before proceeding. Do NOT start the build with a broken baseline.

### Create Feature Branch
```bash
git checkout -b build/dobius-plus-v1
```
All commits go to this branch. Main stays untouched until BUILD_COMPLETE.

### Initialize Build Files
1. Create `scripts/verify-task.sh` (see appendix at bottom of this file)
2. Create empty `BUILD-LOG.md`
3. Create `claude-progress.json` with initial state (include `"build_branch": "build/dobius-plus-v1"`)
4. Create `HANDOFF.md` with initial state
5. Create `plans/` directory
6. Record baseline: `echo "Fresh project — no tests yet" > .test-baseline.txt`

**Create**: `scripts/verify-task.sh`, `BUILD-LOG.md`, `claude-progress.json`, `HANDOFF.md`, `plans/`, `.test-baseline.txt`
**Verify**: On branch `build/dobius-plus-v1`, all infrastructure files exist
**Commit**: "Task 0.1: Init autonomous build infrastructure on build/dobius-plus-v1"

---

# PHASE 1 — Electron Scaffold + Terminal (Tasks 1.1 – 1.3)

## Task 1.1: Scaffold Electron + Vite + React project
**Action**: Create the full project scaffold with all dependencies. Reference `../gmail-mcp/desktop-app/` for patterns.

**Create/Modify**:
- `package.json` — scripts: `dev`, `electron:dev`, `build`, `electron:build`
- `vite.config.js` — `base: './'`, React plugin, port 5173
- `electron/main.js` — single BrowserWindow, dev/prod loading, app lifecycle
- `electron/preload.js` — minimal contextBridge with platform info
- `src/main.jsx` — React entry with createRoot
- `src/App.jsx` — minimal "Dobius+" text
- `src/styles/index.css` — Tailwind imports
- `tailwind.config.js` or Tailwind v4 CSS config
- `index.html` — Vite entry with root div

Install all deps:
```bash
npm init -y
npm install react react-dom zustand chokidar
npm install -D electron electron-builder vite @vitejs/plugin-react tailwindcss @tailwindcss/vite postcss concurrently wait-on
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
npm install node-pty
npx electron-rebuild
```

**Verify**: `npm run electron:dev` opens an Electron window showing "Dobius+" text. Window uses `titleBarStyle: 'hiddenInset'` and dark background.
**Commit**: "Task 1.1: Scaffold Electron + Vite + React project"

## Task 1.2: Implement terminal-manager.js (node-pty backend)
**Action**: Create the node-pty terminal session manager in the Electron main process.

**Create/Modify**:
- `electron/terminal-manager.js`:
  - `createTerminal(id, cwd, webContents)` — spawn `zsh` via node-pty, store in Map, forward data to renderer via `webContents.send('terminal:data', id, data)`
  - `writeTerminal(id, data)` — write to pty stdin
  - `resizeTerminal(id, cols, rows)` — resize pty
  - `killTerminal(id)` — kill pty, remove from Map
  - `killAll()` — kill all ptys (for app quit)
  - Export Map for cleanup
- `electron/main.js` — add IPC handlers: `terminal:create`, `terminal:write`, `terminal:resize`, `terminal:kill`
- `electron/preload.js` — expose terminal IPC: `terminalCreate(id, cwd)`, `terminalWrite(id, data)`, `terminalResize(id, cols, rows)`, `terminalKill(id)`, `onTerminalData(callback)` (ipcRenderer.on)
- Add `before-quit` cleanup to main.js

**Verify**: App launches. In devtools console: `window.electronAPI.terminalCreate('test', '/tmp')` succeeds without crash. Check that pty process spawns: `ps aux | grep "zsh.*pts"`.
**Commit**: "Task 1.2: Implement terminal-manager.js with node-pty backend"

## Task 1.3: Implement TerminalPane component (xterm.js frontend)
**Action**: Create the React component that renders a real terminal using xterm.js, connected to node-pty via IPC.

**Create/Modify**:
- `src/components/Project/TerminalPane.jsx`:
  - Mount xterm Terminal to a div ref
  - On mount: call `terminalCreate(id, cwd)` via IPC
  - Listen for `terminal:data` events → `term.write(data)`
  - On user input: `term.onData(data => terminalWrite(id, data))`
  - FitAddon: auto-fit on mount + ResizeObserver → `terminalResize(id, cols, rows)`
  - WebLinksAddon for clickable URLs
  - Accept `theme` prop for xterm theme colors
  - On unmount: kill terminal
- `src/hooks/useTerminal.js` — encapsulate the xterm setup + IPC bridge logic
- `src/App.jsx` — render TerminalPane full-screen for testing

**Verify**: App launches with a full-screen terminal. You can type commands (`ls`, `pwd`). The terminal renders with colors. Resizing the window resizes the terminal. Type `claude --help` to confirm Claude CLI works in the embedded terminal.
**Commit**: "Task 1.3: Implement TerminalPane with xterm.js + IPC bridge"

---

# PHASE 2 — Themes + Data Layer (Tasks 2.1 – 2.2)

## Task 2.1: Implement themes system
**Action**: Port the 10 dark themes from `../claude-terminal/themes.sh` to JavaScript and create a theme picker.

**Create/Modify**:
- `src/lib/themes.js` — export array of 10 themes, each with:
  ```js
  { name: "Midnight", bg: "#0D1117", fg: "#E6EDF3", cursor: "#58A6FF",
    accent1: "#58A6FF", accent2: "#3FB950", accent3: "#D29922", accent4: "#F85149",
    xtermTheme: { background: "#0D1117", foreground: "#E6EDF3", cursor: "#58A6FF",
      black: "#0D1117", red: "#F85149", green: "#3FB950", yellow: "#D29922",
      blue: "#58A6FF", magenta: "#BC8CFF", cyan: "#39D353", white: "#E6EDF3" } }
  ```
- `src/styles/index.css` — CSS variables: `--bg`, `--fg`, `--accent`, `--border`, `--surface`, `--dim`
- `src/components/shared/ThemePicker.jsx` — dropdown with color preview swatches for each theme
- Update `TerminalPane.jsx` to accept and apply theme.xtermTheme
- Update `src/App.jsx` to apply theme CSS variables to root element

**Verify**: App launches. Terminal uses Midnight theme colors by default. ThemePicker renders (add it temporarily to App.jsx). Switching themes changes both the terminal colors and the UI background.
**Commit**: "Task 2.1: Implement 10-theme system with per-window application"

## Task 2.2: Implement data-service.js (file parsing + watchers)
**Action**: Create the main process data service that reads all `~/.claude/` files and exposes them via IPC.

**Create/Modify**:
- `electron/data-service.js`:
  - `loadHistory()` — read `~/.claude/history.jsonl`, parse JSONL, dedupe by sessionId (keep latest), sort by timestamp desc, limit 100. Return array of `{ sessionId, project, display, timestamp, age }`
  - `loadStats()` — parse `~/.claude/stats-cache.json`, return full object
  - `loadSettings()` — parse `~/.claude/settings.json`, extract hooks/mcpServers/enabledPlugins
  - `loadPlans()` — list `~/.claude/plans/*.md`, return `{ name, path, modifiedTime }`
  - `loadSkills()` — list `~/.claude/skills/*/`, extract description from SKILL.md frontmatter
  - `loadTranscript(sessionId, projectPath)` — read tail ~100 lines of transcript JSONL, extract user/assistant messages, return array of `{ role, content, timestamp }`
  - `getActiveProcesses()` — `ps aux | grep claude` to find running session PIDs
  - `watchFiles(webContents)` — chokidar watchers on `history.jsonl` + `stats-cache.json`, send `data:updated` event to renderer
  - **CRITICAL**: All operations are READ-ONLY. No writes to `~/.claude/`.
- `electron/main.js` — add IPC handlers: `data:loadHistory`, `data:loadStats`, `data:loadSettings`, `data:loadPlans`, `data:loadSkills`, `data:loadTranscript`, `data:getActiveProcesses`
- `electron/preload.js` — expose all data IPC methods + `onDataUpdated(callback)`

**Verify**: App launches. In devtools console: `await window.electronAPI.dataLoadHistory()` returns array of sessions with sessionId/project/display/timestamp fields. `await window.electronAPI.dataLoadStats()` returns stats object. No errors for any data call. Verify NO writes to `~/.claude/`: `grep -rc 'writeFile\|fs.write\|unlink' electron/data-service.js` must be 0.
**Commit**: "Task 2.2: Implement data-service.js with read-only ~/.claude/ parsing"

---

# PHASE 3 — UI Layout + Sidebar (Tasks 3.1 – 3.3)

## Task 3.1: Implement ProjectView layout with top bar
**Action**: Create the main project window layout with Terminal/Dashboard toggle and theme picker.

**Create/Modify**:
- `src/components/shared/TopBar.jsx` — project name (centered), [Terminal] and [Dashboard] toggle buttons (left), ThemePicker (right). Styled with theme CSS variables. Height ~40px.
- `src/components/shared/StatusBar.jsx` — bottom bar showing session count, message count, active PID if running. Height ~24px.
- `src/components/Project/ProjectView.jsx` — flexbox layout:
  - TopBar (fixed top)
  - Content area (flex-1): sidebar (left, 280px, collapsible) + main area (right, flex-1)
  - StatusBar (fixed bottom)
  - State: `activeView` ('terminal' | 'dashboard'), `sidebarVisible` (boolean)
- `src/store/store.js` — Zustand store with: `activeView`, `sidebarVisible`, `currentTheme`, `sessions`, `stats`
- `src/App.jsx` — render ProjectView

**Verify**: App shows TopBar with project name, Terminal/Dashboard buttons, ThemePicker. Clicking Terminal/Dashboard toggles the view (show placeholder text for each). StatusBar at bottom. Sidebar area visible on left (placeholder content). Theme changes apply to all UI chrome.
**Commit**: "Task 3.1: Implement ProjectView layout with top bar and status bar"

## Task 3.2: Implement conversation Sidebar
**Action**: Build the conversation history sidebar that loads from data-service.

**Create/Modify**:
- `src/components/Project/Sidebar.jsx` — scrollable sidebar:
  - Search input at top (filters conversations by text)
  - Pinned section (if any pinned conversations)
  - Recent conversations list, grouped by project
  - Each item: project name, time ago, preview text, green dot if active
  - Click item → select it (highlight)
  - Double-click or Enter → open Preview panel
  - Collapse/expand with Cmd+B
- `src/components/Project/ConversationCard.jsx` — single conversation entry
- `src/components/Project/Preview.jsx` — transcript viewer:
  - Shows user messages (green) and assistant messages (blue)
  - Scrollable
  - Header: project, slug, time ago
  - "Resume in Terminal" button → launches `claude --resume <sessionId>` in TerminalPane
  - "Close Preview" button
- `src/hooks/useSessions.js` — calls `dataLoadHistory()` on mount, watches for `data:updated` events, returns `{ sessions, loading, search, setSearch }`
- `src/lib/time-ago.js` — format timestamps as "3m ago", "2h ago", "1d ago"
- `src/lib/electron-api.js` — thin wrapper around `window.electronAPI` with TypeScript-like JSDoc

**Verify**: Sidebar loads and shows recent conversations from `~/.claude/history.jsonl`. Search filters the list. Clicking a conversation highlights it. Clicking "Preview" shows transcript messages. "Resume in Terminal" button works (switches to Terminal view and runs `claude --resume <id>`). Pin toggle works (but doesn't persist yet — that's Task 3.3).
**Commit**: "Task 3.2: Implement conversation sidebar with search and preview"

## Task 3.3: Implement pin persistence + config storage
**Action**: Add config persistence so themes, pins, and window positions survive app restarts.

**Create/Modify**:
- `electron/config-manager.js`:
  - Config path: `~/Library/Application Support/Dobius/config.json`
  - `loadConfig()` — read config, return parsed JSON (or defaults if missing)
  - `saveConfig(config)` — write config (debounced 500ms)
  - `getProjectConfig(projectPath)` — return per-project settings from config
  - `setProjectConfig(projectPath, settings)` — merge into config and save
  - Default config: `{ defaultTheme: 0, projects: {}, pinnedSessions: [], launcherBounds: null }`
- `electron/main.js` — add IPC handlers: `config:load`, `config:save`, `config:getProject`, `config:setProject`
- `electron/preload.js` — expose config IPC
- Update Sidebar to load/save pinned sessions via config
- Update ThemePicker to save selected theme to project config
- Update main.js to save/restore window bounds on move/resize/close

**Verify**: Pin a conversation → quit app → relaunch → conversation is still pinned. Change theme → quit → relaunch → theme persists. Move/resize window → quit → relaunch → window opens at same position/size. Config file exists at `~/Library/Application Support/Dobius/config.json`.
**Commit**: "Task 3.3: Implement config persistence for pins, themes, and window bounds"

---

# PHASE 4 — Dashboard + Multi-Window (Tasks 4.1 – 4.3)

## Task 4.1: Implement Dashboard tabs
**Action**: Create the 6-tab dashboard view matching the Dobius TUI.

**Create/Modify**:
- `src/components/Dashboard/DashboardView.jsx` — tab bar + tab content container
- `src/components/Dashboard/Overview.jsx` — session info (current session, model, working dir), quick stats (total sessions, messages, tools used today), active Claude processes
- `src/components/Dashboard/MCPServers.jsx` — table of MCP servers from settings.json (name, command, args, env vars)
- `src/components/Dashboard/Skills.jsx` — grid of installed skills with descriptions
- `src/components/Dashboard/Stats.jsx` — model usage table (input/output/cache tokens), daily activity table (date, messages, sessions, tools), hour distribution bar
- `src/components/Dashboard/Sessions.jsx` — full session history with columns (project, display, time, duration), sortable, filterable
- `src/components/Dashboard/Plans.jsx` — plan files list, click to expand and show markdown content
- `src/hooks/useStats.js` — calls `dataLoadStats()`, `dataLoadSettings()`, watches for updates

**Verify**: Switch to Dashboard view. All 6 tabs render with real data. Overview shows session count and active processes. MCP tab lists your 32 MCP servers. Skills tab shows your 13 skills. Stats tab shows model usage numbers. Sessions tab shows recent sessions. Plans tab lists plan files. No crashes, no empty tabs.
**Commit**: "Task 4.1: Implement 6-tab dashboard with real data"

## Task 4.2: Implement multi-window support
**Action**: Add ability to open multiple project windows, each with independent terminal + theme.

**Create/Modify**:
- `electron/window-manager.js`:
  - `projectWindows` Map: projectPath → BrowserWindow
  - `openProjectWindow(projectPath, config)` — create new BrowserWindow, pass project path via URL query param, apply saved bounds/theme from config
  - If window already exists for project, focus it instead of creating new
  - Each window tracks its own terminal sessions
  - On window close: kill all terminals for that project, remove from Map
  - `getOpenProjects()` — return list of open project paths
- `electron/main.js`:
  - Add IPC: `window:openProject`, `window:getOpen`, `window:close`
  - Update terminal IPC to route data to correct window's webContents
  - App doesn't quit when last project window closes (launcher stays open)
- `electron/preload.js` — expose window IPC
- `src/App.jsx` — read `projectPath` from URL query params, pass to ProjectView
- `src/components/Project/ProjectView.jsx` — use project path from props for all data calls (filter sessions by project)

**Verify**: Open app. Call `window.electronAPI.windowOpenProject('/Users/statusmacbook2024/Projects (Code)/dobius-plus')` from devtools. A second window opens. Both windows have independent terminals. Each window can have a different theme. Closing one window doesn't close the other.
**Commit**: "Task 4.2: Implement multi-window support with per-window terminals"

## Task 4.3: Implement Launcher window
**Action**: Create the main hub window that lists projects and opens project windows.

**Create/Modify**:
- `src/components/Launcher/ProjectList.jsx` — grid of project cards:
  - Derive projects from `~/.claude/projects/` directories
  - Each card: decoded project name, last session time, session count, theme color swatch
  - Sort by most recent activity
  - Click → open project window (or focus if already open)
  - Search box to filter projects
- `src/components/Launcher/ProjectCard.jsx` — single project card with hover effects
- `src/App.jsx` — if no `projectPath` in URL params, render Launcher. Otherwise render ProjectView.
- `electron/main.js` — initial window is the Launcher (no project param). Launcher closing quits the app.
- `electron/data-service.js` — add `listProjects()`: scan `~/.claude/projects/`, decode paths, count sessions per project, find latest timestamp

**Verify**: App opens to Launcher showing grid of projects. Your projects appear with names, session counts, and last activity. Clicking a project opens a new themed window with terminal. The Launcher stays open. Opening the same project again focuses the existing window instead of creating a duplicate.
**Commit**: "Task 4.3: Implement Launcher window with project grid"

---

# PHASE 5 — Build + Polish (Tasks 5.1 – 5.2)

## Task 5.1: Build, package, and install
**Action**: Set up electron-builder and create the build/install pipeline.

**Create/Modify**:
- `build/icon.png` — create a simple placeholder icon (256x256 solid dark with "D+" text, or download a free icon)
- `electron-builder.yml`:
  ```yaml
  appId: com.statusdigital.dobius-plus
  productName: "Dobius+"
  mac:
    category: public.app-category.developer-tools
    target: dmg
    darkModeSupport: true
  dmg:
    title: "Dobius+"
    contents:
      - x: 130
        y: 220
      - x: 410
        y: 220
        type: link
        path: /Applications
  directories:
    output: dist-electron
    buildResources: build
  files:
    - dist/**/*
    - electron/**/*
    - node_modules/node-pty/**/*
    - package.json
  ```
- `build-and-install.sh`:
  ```bash
  #!/bin/bash
  set -e
  npm run build
  rm -rf dist-electron
  npx electron-builder --mac
  osascript -e 'tell application "Dobius+" to quit' 2>/dev/null || true
  pkill -f "Dobius+" 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/Dobius+.app"
  DMG=$(ls -t dist-electron/*.dmg | head -1)
  hdiutil attach "$DMG" -nobrowse -quiet
  VOLUME=$(ls -d /Volumes/Dobius+* | head -1)
  cp -R "$VOLUME/Dobius+.app" "/Applications/"
  hdiutil detach "$VOLUME" -quiet
  echo "Installed to /Applications/Dobius+.app"
  open "/Applications/Dobius+.app"
  ```
- Make build script executable: `chmod +x build-and-install.sh`
- `package.json` — ensure `"main": "electron/main.js"` and build scripts are correct

**Verify**: `npm run build` succeeds (Vite). `npm run electron:build` produces a DMG in `dist-electron/`. `./build-and-install.sh` installs to `/Applications/` and launches. App opens from Finder.
**Commit**: "Task 5.1: Build pipeline with electron-builder and DMG installer"

## Task 5.2: Polish — keyboard shortcuts + error handling
**Action**: Add keyboard shortcuts and graceful error handling.

**Create/Modify**:
- `electron/main.js` — register global shortcuts:
  - Cmd+N: open project picker (focus Launcher)
  - Window menu: list all open project windows
- `src/components/Project/ProjectView.jsx` — local keyboard shortcuts:
  - Cmd+T or Ctrl+T: toggle Terminal/Dashboard
  - Cmd+B or Ctrl+B: toggle sidebar
  - Cmd+K or Ctrl+K: clear terminal
- Error handling:
  - If `~/.claude/` doesn't exist: show friendly "Claude Code not installed" message in Launcher
  - If `history.jsonl` is empty/missing: show "No conversations yet" in sidebar
  - If node-pty fails to spawn: show error in terminal pane with retry button
  - If Claude CLI not found: show "Install Claude Code" message when trying to resume
- `src/components/shared/ErrorBoundary.jsx` — React error boundary wrapping ProjectView

**Verify**: Cmd+T toggles between Terminal and Dashboard. Cmd+B toggles sidebar. Cmd+N brings Launcher to front. If you temporarily rename `~/.claude/history.jsonl`, sidebar shows "No conversations" instead of crashing. All error states show friendly messages, not blank screens or crashes.
**Commit**: "Task 5.2: Polish with keyboard shortcuts and error handling"

---

# FINAL PHASE — Self-Review & Merge

This phase runs AFTER all build tasks are complete. It uses subagents to audit the entire build, fixes all findings, then merges to main.

## Task FINAL.1: Self-Review via Subagents

**Action**: Launch two review subagents in parallel to audit all changes made during this build. They write findings to `SELF-REVIEW-FINDINGS.md`.

Before launching subagents, generate the full diff of this build:
```bash
git diff main...HEAD --stat    # See all files changed
git diff main...HEAD           # Full diff for reviewers
```

Launch these two subagents simultaneously using the Task tool:

### Subagent 1: Code Reviewer (`feature-dev:code-reviewer`)
Prompt:
```
Review the git diff between main and HEAD in this repository. This is an autonomous build — check for:
1. Bugs, logic errors, null/undefined risks
2. Security issues (injection, path traversal, unchecked input)
3. Missing error handling (but NOT empty catch blocks — those are banned)
4. Hardcoded values that should be configurable
5. CRITICAL: Any code that WRITES to ~/.claude/ (must be read-only)

Write your findings to SELF-REVIEW-FINDINGS.md using this EXACT format (one section):

## Code Review Findings
- [ ] **BUG** `file:line` — description of the issue
- [ ] **SECURITY** `file:line` — description
- [ ] **QUALITY** `file:line` — description

Only report issues with HIGH confidence. Do NOT report style preferences or nitpicks.
If you find zero issues, write: "## Code Review Findings\nNo high-confidence issues found."
```

### Subagent 2: Architecture Auditor (`feature-dev:code-explorer`)
Prompt:
```
Analyze the git diff between main and HEAD in this repository. This is an autonomous build — check for:
1. Missing wiring — new modules/functions defined but never called or registered
2. Dead code — functions/exports that nothing imports
3. Incomplete integration — IPC handlers without corresponding preload exposure, or vice versa
4. Pattern violations — new code that doesn't match existing patterns in the codebase
5. Missing error handling for file reads (all ~/.claude/ reads should handle missing files gracefully)

Append your findings to SELF-REVIEW-FINDINGS.md (the file may already have content from another reviewer) using this EXACT format:

## Architecture Audit Findings
- [ ] **WIRING** `file:line` — description (e.g., "function defined but never called")
- [ ] **DEAD CODE** `file:line` — description
- [ ] **INTEGRATION** `file:line` — description
- [ ] **PATTERN** `file:line` — description

Only report issues with HIGH confidence. Do NOT report style preferences.
If you find zero issues, write: "## Architecture Audit Findings\nNo high-confidence issues found."
```

**Verify**: `SELF-REVIEW-FINDINGS.md` exists and contains both review sections
**Do NOT commit yet** — findings must be fixed first.

## Task FINAL.2: Fix All Findings

**Action**: Read `SELF-REVIEW-FINDINGS.md`. For every unchecked item (`- [ ]`):

1. Read the referenced file and line
2. Determine if the finding is valid
3. If valid: fix it, then mark `- [x]` with a note of what you did
4. If false positive: mark `- [x] FALSE POSITIVE — <reason>`
5. After each fix, run `npm run build` to ensure nothing broke

After all items are checked off:
```bash
npm run build              # Must pass
ls src/components/**/*.jsx 2>/dev/null | wc -l  # Should be >= 15
```

**Verify**: Zero unchecked items in `SELF-REVIEW-FINDINGS.md`, build passes
**Commit**: "Task FINAL.2: Fix self-review findings"

## Task FINAL.3: Merge to Main

**Action**: All tasks done, all findings fixed. Merge the feature branch to main.

```bash
# Final gate
npm run build
ls src/components/**/*.jsx 2>/dev/null | wc -l    # Must be >= 15

# Merge
git checkout main
git merge build/dobius-plus-v1 --no-ff -m "Merge build/dobius-plus-v1: Dobius+ v1.0 — multi-window Claude Code desktop app"
```

Update `HANDOFF.md`:
```markdown
# Handoff — Dobius+

## Current: BUILD COMPLETE — all tasks done, self-reviewed, merged to main

## What's Done
<full list of all completed tasks>

## Self-Review
- Findings: N total, N fixed, N false positives
- File: SELF-REVIEW-FINDINGS.md

## Final Stats
- Components: N JSX files
- Electron modules: N
- Themes: 10
- Dashboard tabs: 6

## Blockers
None — build complete
```

**Commit**: "Task FINAL.3: Merge build/dobius-plus-v1 to main — BUILD COMPLETE"

After this commit, the supervisor (if running) will detect BUILD_COMPLETE in HANDOFF.md and stop.

---

# APPENDIX A: verify-task.sh

Create this file at `scripts/verify-task.sh` during Task 0.1:

```bash
#!/bin/bash
# scripts/verify-task.sh — Gate script for Dobius+ autonomous build (v5)
# Usage: bash scripts/verify-task.sh 1.1
# Claude CANNOT proceed to the next task until this exits with code 0.

set -uo pipefail

TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "FAIL: Usage: bash scripts/verify-task.sh <task-number>"
  exit 1
fi

PASS=true
WARNINGS=""

echo "=== Verifying Task $TASK ==="
echo ""

# 1. Plan file must exist
if [ ! -f "plans/TASK-${TASK}.md" ]; then
  echo "FAIL: plans/TASK-${TASK}.md does not exist."
  PASS=false
else
  echo "OK Plan file exists"
fi

# 2. Review file must exist
if [ ! -f "plans/TASK-${TASK}-REVIEW.md" ]; then
  echo "FAIL: plans/TASK-${TASK}-REVIEW.md does not exist."
  PASS=false
else
  echo "OK Review file exists"
fi

# 3. Latest commit must reference this task
LAST_COMMIT=$(git log -1 --format=%s 2>/dev/null || echo "")
if ! echo "$LAST_COMMIT" | grep -qi "Task ${TASK}\|WIP.*${TASK}"; then
  echo "FAIL: Latest commit doesn't reference Task ${TASK}."
  echo "  Last commit: '$LAST_COMMIT'"
  PASS=false
else
  echo "OK Commit references Task ${TASK}"
fi

# 4. Must be on feature branch (not main)
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FAIL: On '$CURRENT_BRANCH' — should be on feature branch. Commits must NOT go directly to main."
  PASS=false
else
  echo "OK On branch: $CURRENT_BRANCH"
fi

# 5. Build must succeed (after Task 1.1 sets up Vite)
if [ -f "vite.config.js" ] || [ -f "vite.config.mjs" ]; then
  echo ""
  echo "--- Build check ---"
  if npm run build 2>/dev/null; then
    echo "OK Build succeeds"
  else
    echo "FAIL: Build errors. Run: npm run build"
    PASS=false
  fi
fi

# 6. Ban checks — source
if [ -d "src" ]; then
  echo ""
  echo "--- Banned patterns (source) ---"
  EMPTY_CATCH=$(grep -rPc 'catch\s*(\(\w+\))?\s*\{\s*\}' src/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  EMPTY_CATCH=${EMPTY_CATCH:-0}
  if [ "$EMPTY_CATCH" -gt 0 ]; then
    echo "FAIL: Found $EMPTY_CATCH empty catch blocks in src/"
    PASS=false
  else
    echo "OK No empty catch blocks"
  fi

  # CRITICAL: Check for writes to ~/.claude/
  CLAUDE_WRITES=$(grep -rc 'writeFile.*\.claude\|fs\.write.*\.claude\|unlink.*\.claude\|rmSync.*\.claude\|mkdirSync.*\.claude' src/ electron/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  CLAUDE_WRITES=${CLAUDE_WRITES:-0}
  if [ "$CLAUDE_WRITES" -gt 0 ]; then
    echo "FAIL: Found $CLAUDE_WRITES writes to ~/.claude/ — MUST be read-only"
    PASS=false
  else
    echo "OK No writes to ~/.claude/"
  fi
fi

# 7. Component count (should grow over time)
if compgen -G "src/components/**/*.jsx" > /dev/null 2>&1 || compgen -G "src/components/*.jsx" > /dev/null 2>&1; then
  COMPONENT_COUNT=$(find src/components -name "*.jsx" 2>/dev/null | wc -l | tr -d ' ')
  echo "OK Component count: $COMPONENT_COUNT"
fi

# 8. BUILD-LOG has entry
if [ -f "BUILD-LOG.md" ]; then
  if grep -q "Task ${TASK}" BUILD-LOG.md 2>/dev/null; then
    echo "OK BUILD-LOG.md has entry"
  else
    WARNINGS="$WARNINGS\n- Missing BUILD-LOG entry"
  fi
fi

# 9. Progress file
if [ -f "claude-progress.json" ]; then
  echo "OK claude-progress.json exists"
else
  WARNINGS="$WARNINGS\n- Missing claude-progress.json"
fi

# 10. HANDOFF.md exists and is up-to-date
if [ -f "HANDOFF.md" ]; then
  if grep -q "Task ${TASK}\|${TASK}" HANDOFF.md 2>/dev/null; then
    echo "OK HANDOFF.md mentions Task ${TASK}"
  else
    echo "FAIL: HANDOFF.md does not mention Task ${TASK}. Update it NOW — stale handoffs waste 20+ min on restart."
    PASS=false
  fi
else
  echo "FAIL: HANDOFF.md missing"
  PASS=false
fi

# Results
echo ""
echo "==========================================="
if [ "$PASS" = true ]; then
  echo "PASS: Task $TASK verified."
  if [ -n "$WARNINGS" ]; then
    echo "Warnings:"; echo -e "$WARNINGS"
  fi
  exit 0
else
  echo "FAIL: Task $TASK has failures. Fix and re-run."
  exit 1
fi
```

---

# APPENDIX B: crackbot-supervisor.sh

Create this file at `scripts/crackbot-supervisor.sh` during Task 0.1:

```bash
#!/bin/bash
# scripts/crackbot-supervisor.sh — Auto-resume wrapper for autonomous builds (v5)
# Usage: bash scripts/crackbot-supervisor.sh AUTONOMOUS-BUILD.md [max-retries]
#
# Watches the Claude process. If it exits before BUILD_COMPLETE,
# auto-resumes with --continue. Stops when BUILD_COMPLETE or max retries hit.

set -uo pipefail

BUILD_FILE="${1:?Usage: crackbot-supervisor.sh <build-file.md> [max-retries]}"
MAX_RETRIES="${2:-5}"
LOG_FILE="scripts/supervisor.log"
RETRY=0

mkdir -p scripts
echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Starting. Build file: $BUILD_FILE, Max retries: $MAX_RETRIES" >> "$LOG_FILE"

# First launch — full prompt
echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Initial launch..." >> "$LOG_FILE"
cat "$BUILD_FILE" | claude --dangerously-skip-permissions -p -
EXIT_CODE=$?

while true; do
  # Check if build is complete
  if [ -f "HANDOFF.md" ] && grep -qi "BUILD.COMPLETE\|BUILD COMPLETE" HANDOFF.md 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] BUILD COMPLETE detected. Exiting." >> "$LOG_FILE"
    echo "[supervisor] Build completed successfully after $RETRY restart(s)."
    exit 0
  fi

  # Check retry limit
  RETRY=$((RETRY + 1))
  if [ "$RETRY" -gt "$MAX_RETRIES" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Max retries ($MAX_RETRIES) reached. Giving up." >> "$LOG_FILE"
    echo "[supervisor] Max retries reached. Check HANDOFF.md and BUILD-LOG.md for status."
    exit 1
  fi

  # Auto-resume
  echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Claude exited (code $EXIT_CODE). Resuming (attempt $RETRY/$MAX_RETRIES)..." >> "$LOG_FILE"
  sleep 5  # Brief pause before resume

  claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists with unchecked items, read it too. Resume from the current task."
  EXIT_CODE=$?
done
```

---

# EMERGENCY PROTOCOLS

## If Build Breaks
1. Run `npm run build 2>&1 | head -20` to see errors
2. Fix errors one at a time
3. Do NOT add type suppressions or skip checks

## If You're Stuck
1. Read the relevant source files again
2. Read the reference files (`../gmail-mcp/desktop-app/electron/main.js`)
3. Write your reasoning to the plan file
4. If truly stuck for > 15 minutes, skip the task and move on — note it in BUILD-LOG.md

## If Context Compresses
1. Commit immediately: `git add -A && git commit -m "WIP: context compress during Task N.N"`
2. Update `HANDOFF.md` with current state, what's next, and key decisions so far
3. Read `claude-progress.json` and `HANDOFF.md`
4. If `SELF-REVIEW-FINDINGS.md` exists, check for unchecked items
5. Re-read this file — specifically the current phase
6. Resume from the interrupted task

---

# CRITICAL REMINDERS (Re-read every 5 tasks)

1. **You are building a fresh Electron app.** Reference `../gmail-mcp/desktop-app/` for patterns.
2. **Run `npm run build` after EVERY task.** Catch errors early.
3. **Read reference source files BEFORE writing new ones.** Match patterns EXACTLY.
4. **NEVER write to ~/.claude/.** Read-only access only. App config goes in `~/Library/Application Support/Dobius/`.
5. **Commit after every task.** `git log` is your recovery mechanism.
6. **Plan file BEFORE code. Review file AFTER code. Gate script BEFORE next task.**
7. **If a task takes < 8 minutes, interrogate yourself.** Fast = probably wrong.
8. **node-pty requires electron-rebuild.** If terminal crashes, run `npx electron-rebuild` again.
9. **Update claude-progress.json AND HANDOFF.md after every task.** They are your save game.
10. **WIP commit before risky operations.** Context can die at any moment — protect your work.
11. **Stay on `build/dobius-plus-v1`.** Never commit to main until FINAL.3.
12. **If verification fails 2+ times, write a lesson.** Future builds learn from your mistakes.
13. **Each window = independent project.** Don't share terminal sessions across windows.

---

# BEGIN

1. Create `plans/` directory: `mkdir -p plans`
2. Run pre-flight checks (see Task 0.1)
3. Create feature branch: `git checkout -b build/dobius-plus-v1`
4. Initialize progress file
5. Start with Task 0.1

DO NOT skip ahead. DO NOT combine tasks. Complete each task fully before starting the next.

# Dobius+ — Autonomous Build Prompt (v5)

## Launch Command (Preferred — with supervisor auto-resume)
```bash
cd "/Users/statusmacbook2024/Projects (Code)/dobius-plus"
bash scripts/crackbot-supervisor.sh BUILD-board-view.md
```

## Resume After Context Death
```bash
claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists, read it too. Resume from the current task."
```

## Morning Verification
```bash
git log --oneline -20
cat HANDOFF.md | head -5
npx vite build
grep -c "{ id:" src/components/Dashboard/DashboardView.jsx  # >= 13 (new Board tab)
```

---

# STEP 0 — Read Lessons Learned (MANDATORY)

If `LESSONS-LEARNED.md` exists, read it NOW.

---

# PREAMBLE

## The Project
Dobius+ is an Electron + Vite + React 19 desktop app wrapping Claude Code CLI. It has Mission Control for agent management and an Agent Memory system (context, journal, experience per agent) from the previous build.

## What Already Exists
- Mission Control: 3-column agent grid with StatsBar, AgentCard, Start/Chat, RUNNING/OFFLINE status
- Agent Memory: per-agent context, journal (auto-captured on exit), experience items, memory injection into system prompts
- `runningAgents` Zustand map: agentId → tabId
- Terminal data flow: node-pty → `terminal:data` IPC → xterm.js in renderer
- Build Monitor pattern: chokidar watcher → IPC event → useBuildMonitor hook → BuildMonitorView
- 12 dashboard tabs + framer-motion transitions

## Critical Rule: Build must pass (npx vite build) and all existing tabs (including Mission Control + agent memory) must keep working
Codebase: `/Users/statusmacbook2024/Projects (Code)/dobius-plus`

---

# GLOBAL RULES

## Micro-Task Cycle
```
PLAN -> IMPLEMENT -> VERIFY -> REVIEW -> COMMIT -> GATE -> LOG
```
Same as previous builds. Plan file before code, review file after, gate script before next task, HANDOFF.md after every commit.

## Git Discipline
All work on `build/board-view`. Never commit to main. WIP commits before risky operations.

## Context Preservation
`claude-progress.json`, `HANDOFF.md`, `BUILD-LOG.md`. Read them when lost.

## Startup Sequence
```bash
echo "=== Dobius+ Board View — Session Init ==="
pwd && git branch --show-current && git log --oneline -10
cat claude-progress.json 2>/dev/null || echo "No progress file"
cat HANDOFF.md 2>/dev/null || echo "No handoff file"
npx vite build 2>&1 | tail -5
```

## MCP Servers
Playwright MCP for visual testing.

---

# ARCHITECTURE REFERENCE

## Read These Files First
| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project docs |
| `src/store/store.js` | Zustand store — `runningAgents`, tab state |
| `src/components/Dashboard/Agents.jsx` | Mission Control — running agent state source |
| `src/components/Dashboard/DashboardView.jsx` | Tab registry — you're adding a new tab |
| `src/hooks/useBuildMonitor.js` | **Key reference** — real-time monitoring hook pattern |
| `src/components/Dashboard/BuildMonitor/BuildMonitorView.jsx` | **Key reference** — live monitoring UI |
| `electron/build-monitor-watcher.js` | Chokidar watcher pattern for file changes |
| `electron/terminal-manager.js` | PTY data flow — `onData` sends to renderer |
| `electron/preload.js` | IPC bridge — `onTerminalData` listener pattern |
| `src/hooks/useTerminal.js` | Terminal hook — data listener setup |

## Key Patterns
- `onTerminalData(callback)` returns unsubscribe function (preload.js lines 15-19)
- Build Monitor: `useBuildMonitor(projectDir)` hook polls + listens for file changes
- Store: `useStore((s) => s.runningAgents)` gives live Map<agentId, tabId>
- ANSI stripping: `str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')` (if not already a util from agent-memory build)
- Cards: `var(--surface)` bg, `var(--border)` border, SF Mono font

## Dependencies
**Already installed:** framer-motion, zustand, recharts, react 19
**Install:** None

---

# PHASE 0 — Setup & Pre-Flight (Task 0.1)

## Task 0.1: Pre-Flight + Branch
```bash
git status --porcelain | wc -l  # Must be 0
npx vite build                  # Must exit 0
git checkout -b build/board-view
```
Create build infrastructure files. Reuse or update existing `scripts/verify-task.sh`.

**Verify**: On branch `build/board-view`, build passes
**Commit**: "Task 0.1: Init build infrastructure on build/board-view"

---

# PHASE 1 — Activity Monitoring Infrastructure (Tasks 1.1 – 1.3)

## Task 1.1: Create useAgentActivity hook for terminal data monitoring
**Action**: Create `src/hooks/useAgentActivity.js` — a custom hook that monitors terminal output for all running agents and extracts activity status.

**Hook API:**
```javascript
function useAgentActivity() {
  // Returns: { [agentId]: { status, lastActivity, linesProcessed, startTime, currentAction } }
}
```

**Implementation:**
1. Read `runningAgents` from Zustand store
2. For each running agent's tabId, listen to `onTerminalData(tabId, data)`
3. Buffer incoming data, strip ANSI codes
4. Parse for activity markers:
   - Lines containing "Read", "Write", "Edit", "Bash", "Grep", "Glob" → extracting tool use
   - Lines with spinners/progress indicators → "Working..."
   - Empty/idle for >5s → "Idle"
   - Exit message → "Completed"
5. Update activity state per agent (debounced to avoid thrash — 500ms)
6. Track: `linesProcessed` (counter), `lastActivity` (timestamp), `currentAction` (parsed string), `startTime` (from tab.createdAt)
7. Clean up listeners when agents are unregistered or component unmounts

**Important**: The `onTerminalData` listener receives ALL terminal output for ALL terminals. Filter by matching termId === agent's tabId. Don't subscribe per-tab — use ONE listener and route data.

**Create**: `src/hooks/useAgentActivity.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.1: useAgentActivity hook for terminal data monitoring"

## Task 1.2: Add activity state to Zustand store
**Action**: Add `agentActivity: {}` to the Zustand store so Board View and other components can access it.

**New state:**
```javascript
agentActivity: {},  // Map<agentId, { status, lastActivity, linesProcessed, startTime, currentAction }>
```

**New actions:**
```javascript
updateAgentActivity: (agentId, activity) => // Merge activity data
clearAgentActivity: (agentId) => // Remove on agent exit
```

Modify `unregisterAgentsByTabId` to also clear `agentActivity` for removed agents.

The `useAgentActivity` hook (Task 1.1) should write to the store via `updateAgentActivity`, making activity data available globally.

**Create/Modify**: `src/store/store.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.2: Add agentActivity state to Zustand store"

## Task 1.3: Wire activity monitoring into ProjectView
**Action**: In `src/components/Project/ProjectView.jsx`, initialize the agent activity monitoring.

1. Import and call `useAgentActivity()` at the top level of ProjectView — this starts monitoring all running agents
2. The hook writes to Zustand store, so all components can read activity data
3. Ensure cleanup on unmount (hook handles this internally)

Also add a `onTerminalData` forwarding mechanism if needed: the existing `useTerminal` hook already receives terminal data per-tab, but we need a global listener for the activity hook. Check if `onTerminalData` can have multiple listeners (it can — `ipcRenderer.on` supports multiple).

**Create/Modify**: `src/components/Project/ProjectView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.3: Wire agent activity monitoring into ProjectView"

---

# PHASE 2 — Board View UI (Tasks 2.1 – 2.4)

## Task 2.1: Register Board tab in DashboardView
**Action**: Add a new "Board" tab to the dashboard.

In `src/components/Dashboard/DashboardView.jsx`:
1. Add `{ id: 'board', label: 'Board' }` to the TABS array — insert it after 'agents' (Mission Control)
2. Import `BoardView` component
3. Add `board: () => <BoardView />` to TAB_CONTENT
4. Add a running agent count badge on the Board tab (like sessions count badge) — show green dot when agents are running

**Create/Modify**: `src/components/Dashboard/DashboardView.jsx`
**Verify**: `npx vite build` exits 0. `grep -c "{ id:" src/components/Dashboard/DashboardView.jsx` returns 13.
**Commit**: "Task 2.1: Register Board tab in DashboardView"

## Task 2.2: Create BoardView component with live agent cards
**Action**: Create `src/components/Dashboard/Board/BoardView.jsx` — the main Board View component.

**Layout:**
1. **Header**: "Board" title + "Live agent activity" subtitle + running agent count
2. **Active Agents Grid** (2-column): One card per running agent showing:
   - Agent name (bold)
   - Status badge: Working / Idle / Completed (colored dot)
   - Current action: "Reading src/store/store.js" or "Writing file" or "Running tests" (from agentActivity)
   - Lines processed counter
   - Elapsed time (auto-updating every second using setInterval)
   - Progress pulse animation (framer-motion) when status === "Working"
   - "View" button → switches to agent's terminal tab
   - "Stop" button → kills agent's terminal (with confirmation)
3. **Empty State**: When no agents running — "No agents are currently running" + "Go to Mission Control" button
4. **Recent Completions** (below grid): List of recently completed agents (from journal entries within last hour) showing name, duration, exit code

**Styling**: Follow existing card patterns — `var(--surface)`, `var(--border)`, SF Mono font, framer-motion entrance animations with stagger.

**Create**: `src/components/Dashboard/Board/BoardView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.2: BoardView with live agent activity cards"

## Task 2.3: Add activity timeline to Board View
**Action**: Add an activity timeline section to BoardView showing a chronological feed of agent actions.

**Timeline Feed** (below the agent cards grid):
- Scrollable area, max height 300px
- Each entry: `[HH:MM:SS] AgentName — action description`
- Color-coded by action type: file reads (blue), writes (green), bash commands (yellow), errors (red)
- Auto-scrolls to bottom as new entries arrive
- Max 100 entries (FIFO buffer)

The timeline data comes from `agentActivity` — each time the activity hook detects a new action, it should also append to a timeline array in the store.

**Add to store**: `activityTimeline: []` (max 100 entries) + `appendActivityTimeline(entry)`

**Create/Modify**: `src/components/Dashboard/Board/BoardView.jsx`, `src/store/store.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.3: Activity timeline feed in Board View"

## Task 2.4: Board notification + auto-switch on agent completion
**Action**: Add notifications and auto-switch behavior:

1. When an agent completes (detected via `onTerminalExit` for a running agent):
   - Show a brief notification banner at the top of the Board View: "Agent Name completed (exit code 0)" — auto-dismiss after 5s
   - If the user is NOT on the Board tab, show a green dot badge on the Board tab (like the builds tab badge)
2. Add `boardNotification` state to Zustand store
3. Clear the notification badge when user switches to Board tab

**Create/Modify**: `src/components/Dashboard/Board/BoardView.jsx`, `src/store/store.js`, `src/components/Dashboard/DashboardView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.4: Board notifications and completion alerts"

---

# PHASE 3 — Integration & Polish (Tasks 3.1 – 3.2)

## Task 3.1: Cross-link Mission Control and Board View
**Action**: Add navigation links between Mission Control and Board View:

1. In Mission Control (`Agents.jsx`): When agents are running, show a "View on Board →" link below the StatsBar that switches to the Board tab
2. In Board View: Each agent card has a "Configure →" link that switches to Mission Control tab
3. In Mission Control StatsBar: Make the "Agents" stat card clickable — if running agents > 0, clicking switches to Board tab

**Create/Modify**: `src/components/Dashboard/Agents.jsx`, `src/components/Dashboard/Board/BoardView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 3.1: Cross-link Mission Control and Board View"

## Task 3.2: Visual polish and edge cases
**Action**: Final polish pass:

1. **Loading state**: Skeleton loader for Board View while activity data initializes
2. **Elapsed time format**: "2m 15s" for short runs, "1h 23m" for long runs
3. **Card transitions**: framer-motion AnimatePresence when agents start/stop (cards appear/disappear smoothly)
4. **Timeline performance**: Virtualize if > 50 entries (or just limit to 50 with "older entries hidden" note)
5. **Responsive**: 1-column on narrow widths, 2-column on wider
6. **Empty Board with Memory**: If no agents running but agent memory has recent completions, show those as a "Recent Activity" section

**Create/Modify**: `src/components/Dashboard/Board/BoardView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 3.2: Visual polish — loading, transitions, responsive, edge cases"

---

# FINAL PHASE — Self-Review & Merge

## Task FINAL.1: Self-Review via Subagents
Launch `feature-dev:code-reviewer` and `feature-dev:code-explorer` to audit `git diff main...HEAD`. Write to `SELF-REVIEW-FINDINGS.md`.

## Task FINAL.2: Fix All Findings
Fix, mark `[x]`, verify build after each fix.
**Commit**: "Task FINAL.2: Fix self-review findings"

## Task FINAL.3: Merge to Main
```bash
npx vite build
grep -c "{ id:" src/components/Dashboard/DashboardView.jsx  # >= 13
git checkout main
git merge build/board-view --no-ff -m "Merge build/board-view: Live Board View with agent activity monitoring, timeline, and notifications"
```
Update `HANDOFF.md` with BUILD COMPLETE.
**Commit**: "Task FINAL.3: Merge build/board-view to main — BUILD COMPLETE"

---

# CRITICAL REMINDERS

1. You are extending an existing codebase. Break nothing.
2. `npx vite build` after EVERY file change.
3. The `onTerminalData` listener receives data for ALL terminals. Filter by tabId.
4. Activity parsing must be fast — don't block the render loop. Debounce updates.
5. ANSI codes in terminal output must be stripped before parsing.
6. Keep timeline buffer bounded (100 entries max).
7. Stay on `build/board-view`. Never commit to main until FINAL.3.

---

# BEGIN

1. `mkdir -p plans`
2. Pre-flight checks
3. `git checkout -b build/board-view`
4. Start with Task 0.1

DO NOT skip ahead. DO NOT combine tasks.

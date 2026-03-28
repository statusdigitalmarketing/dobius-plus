# Dobius+ — Autonomous Build Prompt (v5)

## Launch Command (Preferred — with supervisor auto-resume)
```bash
cd "/Users/statusmacbook2024/Projects (Code)/dobius-plus"
bash scripts/crackbot-supervisor.sh BUILD-orchestrator.md
```

## Resume After Context Death
```bash
claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists, read it too. Resume from the current task."
```

---

# STEP 0 — Read Lessons Learned (MANDATORY)

If `LESSONS-LEARNED.md` exists, read it NOW.

---

# PREAMBLE

## The Project
Dobius+ is an Electron + Vite + React 19 desktop app wrapping Claude Code CLI. Previous builds added:
- **Mission Control**: Visual agent grid with Start/Chat, RUNNING/OFFLINE status, StatsBar
- **Agent Memory**: Per-agent context, journal (auto-capture), experience items, memory injection into prompts
- **Board View**: Live agent activity monitoring, terminal output parsing, activity timeline, notifications

## What Already Exists
- 13 dashboard tabs including Mission Control and Board
- `runningAgents` + `agentActivity` in Zustand store
- `useAgentActivity` hook monitoring terminal output for running agents
- Agent launch: temp file system prompt → terminal tab → `claude --system-prompt-file` char-by-char
- Agent memory: context, journal, experience — injected into prompts on launch
- Board View: live agent cards with status, timeline feed, completion notifications
- Terminal write via `window.electronAPI.terminalWrite(tabId, cmd)` with 5ms char-by-char delay
- Agent memory IPC: `agentMemory:get/setContext/appendJournal/addExperience`

## Critical Rule: Build must pass (npx vite build) and all 13 existing dashboard tabs + Mission Control + Board View + Agent Memory must keep working
Codebase: `/Users/statusmacbook2024/Projects (Code)/dobius-plus`

---

# GLOBAL RULES

Same as previous builds: PLAN → IMPLEMENT → VERIFY → REVIEW → COMMIT → GATE → LOG.
All work on `build/orchestrator`. Never commit to main. Update HANDOFF.md after every task.

## Startup Sequence
```bash
echo "=== Dobius+ Orchestrator — Session Init ==="
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
| `src/store/store.js` | Zustand — runningAgents, agentActivity, tabs |
| `src/components/Dashboard/Agents.jsx` | Mission Control — handleLaunch, agent cards |
| `src/components/Dashboard/Board/BoardView.jsx` | Board View — activity monitoring |
| `src/hooks/useAgentActivity.js` | Activity hook — terminal output parsing |
| `electron/main.js` (lines 228-306) | Agent IPC, BUILTIN_AGENTS |
| `electron/config-manager.js` | Config + agentMemory storage |
| `electron/preload.js` | All IPC APIs |

## Key Design Decisions for Orchestrator

**Approach**: The Orchestrator is a **React UI component** (not just another Claude agent). It:
1. Presents a task decomposition interface where the user describes what they want
2. Breaks it into sub-tasks (using an LLM call via a dedicated orchestrator agent)
3. Assigns sub-tasks to specialist agents and launches them in parallel tabs
4. Monitors progress via Board View / agentActivity
5. Collects outputs when agents complete
6. Shows a synthesis summary

**Why React UI, not just a Claude agent?** Because:
- Orchestrator needs to create multiple terminal tabs (can't do from inside a single Claude session)
- It needs to monitor other agents (requires Zustand state access)
- It needs to present a structured UI (task list, assignments, progress)
- Claude agent inside a terminal can't programmatically launch other tabs

**The orchestrator DOES use a Claude agent** for task decomposition — it launches a fast model (Haiku) with a system prompt that returns structured JSON tasks. The orchestrator UI then parses and dispatches.

---

# PHASE 0 — Setup & Pre-Flight (Task 0.1)

## Task 0.1: Pre-Flight + Branch
```bash
git status --porcelain | wc -l  # Must be 0
npx vite build                  # Must exit 0
git checkout -b build/orchestrator
```
Create build infrastructure files.
**Commit**: "Task 0.1: Init build infrastructure on build/orchestrator"

---

# PHASE 1 — Orchestrator Data Model & IPC (Tasks 1.1 – 1.2)

## Task 1.1: Define orchestration task model and config storage
**Action**: Add orchestration support to the config/store layer.

**Orchestration Run Schema** (stored in `config.orchestrationRuns[]`, max 20 runs):
```javascript
{
  id: string,              // 'orch-{timestamp}-{random}'
  description: string,     // User's original task description
  createdAt: number,
  status: 'planning' | 'running' | 'completed' | 'failed',
  subtasks: [
    {
      id: string,          // 'subtask-{N}'
      title: string,       // Short task title
      description: string, // What the specialist should do
      agentId: string,     // Which agent to assign
      tabId: string | null,// Terminal tab (set when launched)
      status: 'pending' | 'running' | 'completed' | 'failed',
      startedAt: number | null,
      completedAt: number | null,
      exitCode: number | null,
      outputSummary: string | null,  // Extracted from terminal on completion
    }
  ],
  synthesis: string | null,  // Final combined summary
  completedAt: number | null,
}
```

**Config functions** (in `config-manager.js`):
- `getOrchestrationRuns()` — returns array (max 20, FIFO)
- `saveOrchestrationRun(run)` — create/update run
- `deleteOrchestrationRun(runId)` — remove

**IPC handlers** (in `main.js`):
- `orchestration:list` — returns all runs
- `orchestration:save(run)` — validates + saves
- `orchestration:delete(runId)` — removes
- `orchestration:get(runId)` — returns single run

**Preload** (in `preload.js`):
- `orchestrationList/Save/Delete/Get` methods

**Create/Modify**: `electron/config-manager.js`, `electron/main.js`, `electron/preload.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.1: Orchestration run model, config storage, and IPC"

## Task 1.2: Add orchestration state to Zustand store
**Action**: Add orchestration state to `src/store/store.js`:

```javascript
activeOrchestration: null,  // Current orchestration run object (or null)

setActiveOrchestration: (run) => set({ activeOrchestration: run }),
updateSubtaskStatus: (runId, subtaskId, updates) => // Update a subtask's status/tabId/etc
clearOrchestration: () => set({ activeOrchestration: null }),
```

**Create/Modify**: `src/store/store.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.2: Add orchestration state to Zustand store"

---

# PHASE 2 — Orchestrator UI (Tasks 2.1 – 2.5)

## Task 2.1: Create Orchestrator tab in dashboard
**Action**: Add a new "Orchestrator" tab to the dashboard.

In `DashboardView.jsx`:
1. Add `{ id: 'orchestrator', label: 'Orchestrator' }` to TABS — insert after 'board'
2. Import `OrchestratorView`
3. Add `orchestrator: () => <OrchestratorView />`

Create `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` with basic structure:
- Header: "Orchestrator" title + "Delegate tasks to your agent team" subtitle
- Two states: "No active orchestration" (shows task input) vs "Active orchestration" (shows progress)

**Create**: `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Modify**: `src/components/Dashboard/DashboardView.jsx`
**Verify**: `npx vite build` exits 0. Tab count = 14.
**Commit**: "Task 2.1: Register Orchestrator tab in DashboardView"

## Task 2.2: Task input and decomposition interface
**Action**: Build the task input UI in OrchestratorView.

**When no active orchestration:**
1. Large textarea: "Describe what you want to accomplish..."
2. Agent selector: Checkboxes for which agents are available (all agents from `agentsList`)
3. "Decompose & Launch" button (accent color)

**When "Decompose & Launch" is clicked:**
1. Set status to 'planning'
2. Launch a fast Claude agent (Haiku) with a system prompt that says:
   ```
   You are a task decomposition assistant. Given a user's task description and a list of available specialist agents, break the task into 2-5 independent sub-tasks. Each sub-task should be assignable to one specialist agent.

   Available agents: [list agent names + descriptions]

   Respond with ONLY valid JSON (no markdown, no explanation):
   {
     "subtasks": [
       { "title": "...", "description": "...", "agentName": "..." }
     ]
   }
   ```
3. Send the user's description as input to this agent
4. Parse the JSON response from terminal output
5. Map `agentName` to `agentId` from the agents list
6. Create the orchestration run with subtasks in 'pending' status
7. Save to config via `orchestrationSave`

**Important**: The decomposition agent runs in a temp tab that's cleaned up after parsing. Use `claude -p "task description" --model claude-haiku-4-5-20251001 --system-prompt-file /tmp/decompose.txt` with `-p` flag for non-interactive mode. Capture output, parse JSON, kill tab.

**Create/Modify**: `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.2: Task input and decomposition interface"

## Task 2.3: Subtask assignment and parallel launch
**Action**: After decomposition, show subtasks and launch agents.

**Orchestration Progress UI:**
1. Task description at top (the user's original input)
2. Subtask cards in a list/grid:
   - Title + description
   - Assigned agent badge (name + model)
   - Status: Pending → Running → Completed/Failed
   - Progress indicator (from agentActivity if available)
   - "Launch" button (per subtask) or "Launch All" button
3. Progress bar showing N/total completed

**Launch flow for each subtask:**
1. Build enhanced system prompt: agent's original prompt + subtask description + context
2. Write to temp file via `agentsWriteTempPrompt`
3. Create new tab via `addTab`, rename to `"[Orch] {subtaskTitle}"`
4. Register running agent
5. Write claude command to tab
6. Update subtask: `tabId`, `status: 'running'`, `startedAt`
7. Save orchestration run to config

"Launch All" launches subtasks sequentially with 1s delay between each (to avoid overwhelming the system).

**Create/Modify**: `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.3: Subtask assignment cards and parallel agent launch"

## Task 2.4: Progress monitoring and completion detection
**Action**: Monitor subtask completion and update orchestration state.

1. In `ProjectView.jsx`, extend the `onTerminalExit` handler:
   - When a tab exits, check if it belongs to an active orchestration (match tabId in subtasks)
   - If found, update subtask: `status: 'completed'` (or 'failed' if exitCode !== 0), `completedAt`, `exitCode`
   - Extract outputSummary from terminal scrollback (last 500 chars, ANSI-stripped)
   - Save updated orchestration run to config
   - If ALL subtasks complete, set orchestration `status: 'completed'`

2. In OrchestratorView, show real-time updates:
   - Subtask cards update status as agents complete
   - Show exit code (green check / red X)
   - Show output summary preview
   - Overall progress bar fills as subtasks complete
   - When all done, show "All tasks complete!" banner

3. Use `agentActivity` from the store for live status while agents run.

**Create/Modify**: `src/components/Project/ProjectView.jsx`, `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.4: Progress monitoring and completion detection"

## Task 2.5: Synthesis summary
**Action**: When all subtasks complete, generate and display a synthesis summary.

**Synthesis Flow:**
1. When orchestration `status` becomes 'completed':
   - Collect all subtask `outputSummary` values
   - Display them in a "Results" section of OrchestratorView:
     - Each subtask's output in a collapsible card
     - Overall summary header: "N tasks completed, N failed"
     - Duration: total elapsed time
2. Add a "New Task" button to start a fresh orchestration
3. Add orchestration run to history list (show past runs with timestamp, description, status)

**Synthesis Display:**
- Accordion-style cards for each subtask result
- Subtask title + agent name + duration + exit code
- Output summary text (monospace, pre-formatted)
- Overall status banner: green "All Succeeded" or yellow "N Failed"

**Create/Modify**: `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.5: Synthesis summary and orchestration history"

---

# PHASE 3 — Integration & Polish (Tasks 3.1 – 3.2)

## Task 3.1: Cross-link Orchestrator with Mission Control and Board
**Action**: Wire navigation between all agent-related tabs:

1. Mission Control StatsBar: Add "Orchestrations" stat card showing active count
2. Board View: If an orchestration is active, show "Orchestrated by: {task description}" header above the agent cards that are part of the orchestration
3. Orchestrator: "View on Board →" link when agents are running
4. Agent cards in orchestration: "View Terminal" button switches to the agent's tab

**Create/Modify**: `src/components/Dashboard/Agents.jsx`, `src/components/Dashboard/Board/BoardView.jsx`, `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 3.1: Cross-link Orchestrator, Mission Control, and Board"

## Task 3.2: Visual polish and edge cases
**Action**: Final polish:

1. **Skeleton loaders** for decomposition (while waiting for Haiku response)
2. **Error handling**: If decomposition fails (bad JSON, agent timeout), show error + retry button
3. **Cancel orchestration**: "Cancel" button that kills all running subtask tabs
4. **Responsive layout**: Subtask cards stack vertically on narrow windows
5. **Tab prefixing**: Orchestrated agent tabs prefixed with "[O]" to distinguish from manual launches
6. **Orchestration limit**: Max 1 active orchestration at a time. Show warning if user tries to start another.

**Create/Modify**: `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 3.2: Visual polish — loading, error handling, cancel, responsive"

---

# FINAL PHASE — Self-Review & Merge

## Task FINAL.1: Self-Review via Subagents
Launch `feature-dev:code-reviewer` + `feature-dev:code-explorer` on `git diff main...HEAD`. Write to `SELF-REVIEW-FINDINGS.md`.

## Task FINAL.2: Fix All Findings
Fix, mark `[x]`, verify build.
**Commit**: "Task FINAL.2: Fix self-review findings"

## Task FINAL.3: Merge to Main
```bash
npx vite build
grep -c "{ id:" src/components/Dashboard/DashboardView.jsx  # >= 14
git checkout main
git merge build/orchestrator --no-ff -m "Merge build/orchestrator: Task orchestrator with decomposition, parallel agent launch, progress monitoring, and synthesis"
```
Update `HANDOFF.md` with BUILD COMPLETE.
**Commit**: "Task FINAL.3: Merge build/orchestrator to main — BUILD COMPLETE"

---

# CRITICAL REMINDERS

1. You are extending an existing codebase. Break nothing.
2. `npx vite build` after EVERY file change.
3. Task decomposition uses non-interactive Claude (`-p` flag) — parse stdout for JSON.
4. 5ms char-by-char delay for ALL terminal writes. This is non-negotiable.
5. Agent launches must use the ALLOWED_MODELS allowlist for security.
6. Max 1 active orchestration. Max 5 subtasks per orchestration.
7. Orchestration runs capped at 20 in config (FIFO).
8. Stay on `build/orchestrator`. Never commit to main until FINAL.3.

---

# BEGIN

1. `mkdir -p plans`
2. Pre-flight checks
3. `git checkout -b build/orchestrator`
4. Start with Task 0.1

DO NOT skip ahead. DO NOT combine tasks.

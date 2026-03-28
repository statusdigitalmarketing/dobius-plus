# Dobius+ — Autonomous Build Prompt (v5)

## Launch Command (Preferred — with supervisor auto-resume)
```bash
cd "/Users/statusmacbook2024/Projects (Code)/dobius-plus"
bash scripts/crackbot-supervisor.sh BUILD-agent-memory.md
```

## Resume After Context Death (if not using supervisor)
```bash
claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists, read it too. Resume from the current task."
```

## Morning Verification
```bash
git log --oneline -20
cat HANDOFF.md | head -5                      # Should say BUILD COMPLETE
npx vite build                                # Zero errors
grep -c "{ id:" src/components/Dashboard/DashboardView.jsx  # >= 12
cat claude-progress.json | head -20
```

---

# STEP 0 — Read Lessons Learned (MANDATORY)

If `LESSONS-LEARNED.md` exists in the project root, read it NOW before doing anything else.

---

# PREAMBLE — What You're Working On

## The Project
Dobius+ is an Electron + Vite + React 19 desktop app wrapping Claude Code CLI in themed terminal windows. It has a 12-tab dashboard including "Mission Control" for visual agent management with Start/Chat buttons and RUNNING/OFFLINE status tracking.

## What Already Exists
- Mission Control tab: 3-column agent grid with StatsBar (agents, terminals, sessions, memory), AgentCard with StatusBadge, Start/Chat/Edit/Delete buttons
- `runningAgents` map in Zustand store tracking agentId → tabId
- Terminal exit cleanup via onTerminalExit listener
- 4 built-in agents + custom agent CRUD
- Agent launch: temp file system prompt → new terminal tab → `claude --system-prompt-file` char-by-char
- Config persistence at `~/Library/Application Support/Dobius/config.json` with debounced atomic writes
- Session data access: `~/.claude/projects/` JSONL files, loadAllSessions, loadTranscript

## Critical Rule: Build must pass (npx vite build) and all 12 existing dashboard tabs + Mission Control agent management must keep working
The codebase is at `/Users/statusmacbook2024/Projects (Code)/dobius-plus`. Do NOT create a new project. Do NOT modify existing working functionality.

---

# GLOBAL RULES — Read These Before Every Task

## The Micro-Task Cycle
```
PLAN -> IMPLEMENT -> VERIFY -> REVIEW -> COMMIT -> GATE -> LOG
```

### Step 1: PLAN
Create `plans/TASK-N.N.md` with what you'll change, why, verification, risks.

### Step 2: IMPLEMENT
Write code. Follow existing patterns exactly.

### Step 3: VERIFY
```bash
npx vite build    # MUST exit 0
```
If verification fails 2+ times, append to `LESSONS-LEARNED.md`.

### Step 4: REVIEW
Re-read changed files. Write `plans/TASK-N.N-REVIEW.md` with 3 improvements + 1 fix.

### Step 5: COMMIT + HANDOFF
```bash
git add -A && git commit -m "Task N.N: <description>"
```
Update `HANDOFF.md` immediately after every commit.

### Step 6: GATE
```bash
bash scripts/verify-task.sh N.N
```

### Step 7: LOG
Append to `BUILD-LOG.md`.

## Explicit Bans
- Empty catch blocks, `@ts-ignore`, `@ts-nocheck`, `// eslint-disable`
- `console.log` for errors

## Git Discipline
- All work on `build/agent-memory`. Never commit to main.
- WIP commits before risky operations.
- Update `claude-progress.json` AND `HANDOFF.md` after every task.

## Context Preservation
Maintain `claude-progress.json`, `HANDOFF.md`, `BUILD-LOG.md`. When lost, read them + `git log --oneline -20`.

## Startup Sequence (Run at EVERY Context Window Start)
```bash
echo "=== Dobius+ Agent Memory — Session Init ==="
pwd && git branch --show-current && git log --oneline -10
cat claude-progress.json 2>/dev/null || echo "No progress file"
cat HANDOFF.md 2>/dev/null || echo "No handoff file"
if [ -f SELF-REVIEW-FINDINGS.md ]; then grep '\- \[ \]' SELF-REVIEW-FINDINGS.md; fi
npx vite build 2>&1 | tail -5
```

## MCP Servers Available
Playwright MCP for visual testing.

---

# ARCHITECTURE REFERENCE

## Read These Files First
| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project documentation |
| `src/store/store.js` | Zustand store — runningAgents, tab management |
| `src/components/Dashboard/Agents.jsx` | Mission Control component — you're extending this |
| `electron/main.js` (lines 228-306) | Agent IPC handlers, BUILTIN_AGENTS |
| `electron/config-manager.js` | Config persistence — you're extending the schema |
| `electron/preload.js` | IPC bridge — adding new memory APIs |
| `electron/data-service.js` | Session data access — for experience extraction |
| `src/hooks/useTerminal.js` | Terminal hook — scrollback capture |

## Key Patterns
- Config: debounced writes + atomic rename, `setProjectConfig` for per-project, `updateSettings` for global
- IPC: preload `invoke` → main `ipcMain.handle`, preload `on` → main `webContents.send`
- Checkpoints pattern (main.js lines 183-225): CRUD for saved terminal states — use as template for memory entries
- Agent data in `config.settings.agents[]`, per-project data in `config.projects[path]`

## Dependencies
**Already installed:** framer-motion, zustand, react 19, react-markdown, recharts
**Install:** None

---

# PHASE 0 — Setup & Pre-Flight (Task 0.1)

## Task 0.1: Pre-Flight Validation + Create Infrastructure
**Action**: Validate environment, create feature branch, init build files.

```bash
git status --porcelain | wc -l  # Must be 0 — stash if needed
npx vite build                  # Must exit 0
grep -c "{ id:" src/components/Dashboard/DashboardView.jsx  # Must be 12
git checkout -b build/agent-memory
```

Create `scripts/verify-task.sh`, `BUILD-LOG.md`, `claude-progress.json`, `HANDOFF.md`, `plans/`.

**Verify**: `npx vite build` exits 0, on branch `build/agent-memory`
**Commit**: "Task 0.1: Init autonomous build infrastructure on build/agent-memory"

---

# PHASE 1 — Data Layer: Agent Memory Storage (Tasks 1.1 – 1.3)

## Task 1.1: Extend config schema with agent memory storage
**Action**: In `electron/config-manager.js`, extend the config to support per-agent memory. Add a new top-level `agentMemory` object in the config keyed by agentId.

**Memory Entry Schema:**
```javascript
agentMemory: {
  [agentId]: {
    context: string,        // User-editable notes/context about this agent (max 5000 chars)
    journal: [              // Auto-appended run log entries (max 50 entries, FIFO)
      {
        id: string,         // 'mem-{timestamp}-{random}'
        timestamp: number,  // When the run started
        duration: number,   // Seconds the agent ran
        projectPath: string,
        exitCode: number | null,
        summary: string,    // First 500 chars of terminal output (stripped of ANSI)
        linesOutput: number,
      }
    ],
    experience: string[],   // Extracted lessons/patterns (max 20 items, each max 200 chars)
    lastUpdated: number,    // Timestamp
  }
}
```

Add helper functions:
- `getAgentMemory(agentId)` — returns memory object or empty default
- `setAgentMemory(agentId, memory)` — validates + saves with size guards
- `appendJournalEntry(agentId, entry)` — push to journal, trim to 50 entries FIFO
- `pruneOldMemory(maxAgeDays = 90)` — remove entries older than 90 days

**Create/Modify**: `electron/config-manager.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.1: Extend config schema with agent memory storage"

## Task 1.2: Add IPC handlers for agent memory CRUD
**Action**: In `electron/main.js`, add IPC handlers for memory operations alongside existing agent handlers (after line 306).

**New handlers:**
- `agentMemory:get(agentId)` — returns memory for one agent
- `agentMemory:setContext(agentId, context)` — update context field (max 5000 chars)
- `agentMemory:appendJournal(agentId, entry)` — add journal entry
- `agentMemory:addExperience(agentId, text)` — add experience item (max 20 items)
- `agentMemory:removeExperience(agentId, index)` — remove experience item
- `agentMemory:clear(agentId)` — reset agent memory

All handlers must validate inputs: string length limits, array bounds, sanitize against prototype pollution.

**Create/Modify**: `electron/main.js`
**Verify**: `npx vite build` exits 0. Grep for `agentMemory:` in main.js — should appear 6+ times.
**Commit**: "Task 1.2: Add IPC handlers for agent memory CRUD"

## Task 1.3: Expose memory APIs in preload + auto-capture on agent exit
**Action**:

1. In `electron/preload.js`, add memory API methods:
   - `agentMemoryGet(agentId)` → invoke
   - `agentMemorySetContext(agentId, context)` → invoke
   - `agentMemoryAppendJournal(agentId, entry)` → invoke
   - `agentMemoryAddExperience(agentId, text)` → invoke
   - `agentMemoryRemoveExperience(agentId, index)` → invoke
   - `agentMemoryClear(agentId)` → invoke

2. In `src/components/Project/ProjectView.jsx`, extend the existing `onTerminalExit` listener to auto-capture a journal entry when an agent's terminal exits:
   - Check if the exiting tabId is in `runningAgents` (reverse lookup: find agentId where tabId matches)
   - If found, capture: timestamp, duration (now - tab.createdAt), exitCode, projectPath
   - Extract summary from terminal scrollback (first 500 chars of last 20 lines, ANSI-stripped)
   - Call `agentMemoryAppendJournal(agentId, entry)`

For ANSI stripping, create a simple utility: `stripAnsi(str)` that removes `\x1b\[[0-9;]*[a-zA-Z]` patterns.

**Create/Modify**: `electron/preload.js`, `src/components/Project/ProjectView.jsx`
**Verify**: `npx vite build` exits 0. Grep for `agentMemory` in preload.js — should appear 6+ times.
**Commit**: "Task 1.3: Expose memory APIs in preload + auto-journal on agent exit"

---

# PHASE 2 — Memory UI in Mission Control (Tasks 2.1 – 2.4)

## Task 2.1: Add memory indicator to AgentCard
**Action**: In `src/components/Dashboard/Agents.jsx`, modify `AgentCard` to show a memory indicator:

- Add a small "Memory" badge next to status badge showing journal entry count (e.g., "3 runs")
- If agent has context notes, show a small document icon
- If agent has experience items, show a star/brain icon
- These are purely visual indicators — clicking opens the memory panel (Task 2.2)

Load memory data in the main `MissionControl` component via `agentMemoryGet(agentId)` for each agent. Store in local state as `agentMemories: { [agentId]: memoryObj }`.

**Create/Modify**: `src/components/Dashboard/Agents.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.1: Add memory indicators to AgentCard"

## Task 2.2: Create expandable memory panel in AgentCard
**Action**: Add an expandable panel to each AgentCard that shows the agent's memory when clicked. Use framer-motion `AnimatePresence` for smooth expand/collapse.

**Memory Panel sections:**
1. **Context** — Editable textarea showing agent's context notes. Save on blur via `agentMemorySetContext`. Placeholder: "Add notes about this agent's role and expertise..."
2. **Journal** — Scrollable list of recent runs. Each entry shows: timestamp (timeAgo format), duration, exit code (green checkmark or red X), summary preview (truncated). Max height 200px with overflow scroll.
3. **Experience** — List of learned patterns. Each item has text + delete (X) button. "Add experience" input at bottom.

The panel should slide down below the action buttons when the card is expanded. Add a "Memory" toggle button in the card's action bar.

**Create/Modify**: `src/components/Dashboard/Agents.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.2: Expandable memory panel with context, journal, experience"

## Task 2.3: Memory injection into agent system prompts on launch
**Action**: Modify `handleLaunch` in `Agents.jsx` to inject memory context into the system prompt when launching an agent.

Before writing the temp file, build an enhanced prompt:
```
[Original system prompt]

---
## Agent Memory (auto-injected by Dobius+)

### Context
[agent's context notes, if any]

### Recent Experience
[agent's experience items, numbered]

### Last 3 Runs
[journal entries: date, project, duration, summary]
```

Only inject if the agent has memory content. Keep the total prompt under the 10,000 char limit — truncate memory section if needed, prioritizing context > experience > journal.

**Create/Modify**: `src/components/Dashboard/Agents.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.3: Inject agent memory into system prompts on launch"

## Task 2.4: Memory management — clear and pruning
**Action**: Add memory management controls:

1. In the memory panel (Task 2.2), add a "Clear Memory" button with confirmation dialog
2. Add auto-pruning: when `appendJournalEntry` is called, also call `pruneOldMemory(90)` to clean entries older than 90 days
3. In the Mission Control StatsBar, update the "Memory" stat card to show actual memory status: "N agents with memory" instead of static "Synced"

**Create/Modify**: `src/components/Dashboard/Agents.jsx`, `electron/config-manager.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.4: Memory management — clear button, auto-pruning, stats"

---

# FINAL PHASE — Self-Review & Merge

## Task FINAL.1: Self-Review via Subagents
Launch `feature-dev:code-reviewer` and `feature-dev:code-explorer` subagents to audit `git diff main...HEAD`. Write findings to `SELF-REVIEW-FINDINGS.md`.

## Task FINAL.2: Fix All Findings
Fix every unchecked item. Mark `[x]` with notes. Run `npx vite build` after each fix.
**Commit**: "Task FINAL.2: Fix self-review findings"

## Task FINAL.3: Merge to Main
```bash
npx vite build
grep -c "{ id:" src/components/Dashboard/DashboardView.jsx  # >= 12
git checkout main
git merge build/agent-memory --no-ff -m "Merge build/agent-memory: Agent memory system with context, journal, experience, and auto-capture"
```
Update `HANDOFF.md` with BUILD COMPLETE + future work notes.
**Commit**: "Task FINAL.3: Merge build/agent-memory to main — BUILD COMPLETE"

---

# APPENDIX A: verify-task.sh

Create at `scripts/verify-task.sh` during Task 0.1 — same as previous build. Key checks:
1. Plan + review files exist
2. Commit references task
3. On feature branch
4. `npx vite build` passes
5. No banned patterns in src/
6. Feature count >= 12
7. HANDOFF.md mentions task

---

# CRITICAL REMINDERS

1. You are extending an existing codebase. Break nothing.
2. Run `npx vite build` after EVERY file change.
3. Read existing source files BEFORE writing new ones. Match patterns EXACTLY.
4. Commit after every task. Update HANDOFF.md.
5. Stay on `build/agent-memory`. Never commit to main until FINAL.3.
6. Memory data must be size-bounded: 5000 chars context, 50 journal entries, 20 experience items.
7. All IPC inputs must be validated and sanitized.

---

# BEGIN

1. `mkdir -p plans`
2. Run pre-flight checks
3. `git checkout -b build/agent-memory`
4. Start with Task 0.1

DO NOT skip ahead. DO NOT combine tasks.

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
claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists, read it too. Resume from the current task."
```

## Morning Verification (check results after overnight run)
```bash
git log --oneline -40
cat SELF-REVIEW-FINDINGS.md 2>/dev/null
cat HANDOFF.md | head -5
npx vite build
echo 0
cat claude-progress.json | head -20
cat scripts/supervisor.log 2>/dev/null
```

---

# STEP 0 — Read Lessons Learned (MANDATORY)

If `LESSONS-LEARNED.md` exists in the project root, read it NOW before doing anything else. It contains mistakes from prior builds — patterns to avoid, detection commands, and fixes. Every lesson is a rule you must follow.

If it doesn't exist, check for `LESSONS-LEARNED-TEMPLATE.md` in the project root or parent directory. If found, copy it to `LESSONS-LEARNED.md` and read the seed lessons.

---

# PREAMBLE — What You're Working On

## The Project
Dobius+ is an Electron desktop app that wraps Claude Code CLI in themed terminal windows with conversation sidebar and dashboard tabs. This build has TWO goals:

1. **UI Overhaul** — The current UI is rough and unpolished. Every component needs a design pass to feel premium: proper spacing, subtle animations, glass morphism, refined typography, and a cohesive design language. No "classic AI feel" — this should look like a premium developer tool.

2. **Build Monitor** — A new dashboard tab that shows real-time progress of crack bot / crack repair autonomous builds by watching `claude-progress.json` files.

## What Already Exists
- Electron 33+ / Vite 7 / React 19 / Zustand / Tailwind 4 / xterm.js / node-pty
- 8 electron modules: main.js, preload.js, terminal-manager.js, data-service.js, data-utils.js, watcher-service.js, window-manager.js, config-manager.js
- 27 React components across Launcher, Project, Dashboard, shared directories
- 6 dashboard tabs: Overview, MCP Servers, Skills, Stats, Sessions, Plans
- 10 dark themes with per-project persistence
- Multi-window support (per-project BrowserWindows)
- File watchers on ~/.claude/ for live data updates
- All data loading is async (fs.promises)
- NOTE: One pre-existing `// eslint-disable-next-line` in src/hooks/useTerminal.js:130 — this is intentional, do NOT remove it

## Design Requirements (CRITICAL — read before every UI task)
The UI must NOT look like a generic AI-generated app. Specific rules:
- **Accent color sparingly**: Only on 1-2 primary CTA buttons (Resume, Open). Everything else uses neutral theme variables.
- **No gradient backgrounds** on cards or containers — use flat `var(--surface)` with subtle `var(--border)`
- **Left-border indicators** for selection states (not full background color swaps)
- **Glass morphism** for overlays and modals: `backdrop-filter: blur(12px)`, semi-transparent bg
- **Staggered fade-in animations** on lists (50ms delay per item)
- **Skeleton loaders** during data fetching — not spinners
- **Typography hierarchy**: section titles in `var(--fg)` not accent, labels in `var(--dim)`, values in `var(--fg)`
- **Micro-interactions**: scale(1.02) on hover for cards, smooth border-color transitions
- **Monospace for data**: PIDs, timestamps, file paths, stats in `'SF Mono', monospace`
- **ALL colors from CSS variables**: `var(--bg)`, `var(--fg)`, `var(--surface)`, `var(--border)`, `var(--dim)`, `var(--accent)`, `var(--accent-muted)`
- Study the existing theme system in `src/lib/themes.js` — every theme generates CSS variables, use ONLY those

## Critical Rule: npx vite build must succeed after every task
The codebase is at `/Users/statusmacbook2024/Projects (Code)/dobius-plus`. Do NOT create a new project. Do NOT modify existing working functionality. All existing features MUST continue working after every single task.

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
npx vite build    # MUST exit 0 — no errors
```

**Auto-append lessons learned**: If verification fails 2 or more times on the same task, you MUST append the failure pattern to `LESSONS-LEARNED.md` before moving on.

### Step 4: REVIEW
After implementing, re-read every file you changed. Write `plans/TASK-N.N-REVIEW.md` with:
1. Three things that could be better
2. One thing you're fixing right now (then fix it)
3. Any concerns about the approach

### Step 5: COMMIT + HANDOFF
```bash
git add -A && git commit -m "Task N.N: <one-line description>"
```

**MANDATORY**: Immediately after committing, update `HANDOFF.md` with current state. This is NON-NEGOTIABLE.

### Step 6: GATE
```bash
bash scripts/verify-task.sh N.N
```
This script MUST exit with code 0 before you start the next task.

### Step 7: LOG
Append to `BUILD-LOG.md`.

---

## Explicit Bans

### In Source Code
| Pattern | Why It's Banned | Detection |
|---------|----------------|-----------|
| Empty catch blocks | Silently swallows errors | `grep -rPc 'catch\s*(\(\w+\))?\s*\{\s*\}' src/ electron/` must be 0 |
| `@ts-ignore` | Hides type errors | `grep -rc '@ts-ignore' src/ electron/` must be 0 |
| `@ts-nocheck` | Disables type checking | `grep -rc '@ts-nocheck' src/ electron/` must be 0 |
| Hardcoded hex colors in JSX | Must use CSS variables | No `#` color literals in component return statements except in themes.js |

**NOTE**: `// eslint-disable-next-line` in useTerminal.js:130 is a pre-existing intentional exception — do NOT count it as a violation.

## Time Guard

After completing each task, check the duration. If any task completed in less than 8 minutes, write a self-critique.

## Git Discipline

- **Feature branch**: All work happens on `build/build-monitor`. NEVER commit directly to main during the build.
- Commit after EVERY task
- **WIP commits**: Before any risky operation, commit current work first

## Context Preservation

Maintain `claude-progress.json`, `HANDOFF.md`, `SELF-REVIEW-FINDINGS.md`, and `BUILD-LOG.md` throughout the build.

### Startup Sequence (Run at EVERY Context Window Start)

```bash
#!/bin/bash
echo "=== Dobius+ — Session Init ==="
pwd
git branch --show-current
git log --oneline -10
cat claude-progress.json 2>/dev/null || echo "No progress file"
cat HANDOFF.md 2>/dev/null || echo "No handoff file"
if [ -f SELF-REVIEW-FINDINGS.md ]; then echo "--- SELF-REVIEW FINDINGS ---"; grep '\- \[ \]' SELF-REVIEW-FINDINGS.md; fi
npx vite build 2>&1 | tail -5
echo "=== Finding next task ==="
```

## Subagent Strategy

Use subagents for parallelizable work. Launch code-reviewer + code-explorer subagents for self-review in the Final Phase.

## MCP Servers Available

Playwright — available for UI testing new components via `mcp__plugin_playwright_playwright__browser_*` tools.

---

# ARCHITECTURE REFERENCE — Read Before Writing Any Code

## FIRST TASK: Read These Files
Before writing a single line of code, you MUST read every one of these files cover-to-cover:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project overview, tech stack, commands |
| `electron/main.js` | App lifecycle, IPC handler registration |
| `electron/data-service.js` | All data loading functions (async) |
| `electron/data-utils.js` | Shared utilities (parseJsonl, timeAgo, pathExists, constants) |
| `electron/watcher-service.js` | chokidar file watchers |
| `electron/preload.js` | Context bridge API |
| `src/components/Dashboard/DashboardView.jsx` | Tab container — you'll add a new tab here |
| `src/components/Dashboard/Overview.jsx` | Reference for dashboard tab pattern |
| `src/components/Dashboard/Stats.jsx` | Reference for data-heavy tab |
| `src/components/Project/ProjectView.jsx` | Main project window layout |
| `src/components/Launcher/ProjectList.jsx` | Launcher grid |
| `src/components/Launcher/ProjectCard.jsx` | Card component pattern |
| `src/components/shared/TopBar.jsx` | Top bar pattern |
| `src/components/shared/StatusBar.jsx` | Status bar pattern |
| `src/components/Project/Sidebar.jsx` | Sidebar pattern |
| `src/store/store.js` | Zustand store |
| `src/lib/themes.js` | Theme system (CSS variables) — STUDY THIS |
| `src/styles/index.css` | Tailwind config + base styles |
| `package.json` | Dependencies and scripts |

## Dependencies
**Already installed:** electron, react, react-dom, zustand, @xterm/xterm, @xterm/addon-fit, @xterm/addon-web-links, node-pty, chokidar, tailwindcss, vite, concurrently, wait-on, electron-builder
**You need to install:** `npm install recharts framer-motion`

---

# PHASE 0 — Setup & Pre-Flight (Task 0.1)

## Task 0.1: Pre-Flight Validation + Create Infrastructure
**Action**: Validate the environment, install new deps, create feature branch, initialize build infrastructure.

### Pre-Flight Checks
```bash
git status --porcelain | wc -l  # Must be 0
npx vite build                  # Must exit 0
df -h . | tail -1               # Warn if < 5GB free
```

### Install Dependencies
```bash
npm install recharts framer-motion
```

### Create Feature Branch
```bash
git checkout -b build/build-monitor
```

### Initialize Build Files
1. Create `scripts/verify-task.sh` (see Appendix A)
2. Create empty `BUILD-LOG.md`
3. Create `claude-progress.json` with initial state
4. Create `HANDOFF.md` with initial state
5. Create `plans/` directory

**Create**: `scripts/verify-task.sh`, `BUILD-LOG.md`, `claude-progress.json`, `HANDOFF.md`, `plans/`
**Verify**: `npx vite build` exits 0, on branch `build/build-monitor`
**Commit**: "Task 0.1: Init autonomous build infrastructure on build/build-monitor"

---

# PHASE 1 — UI Overhaul (Tasks 1.1 – 1.5)

## Task 1.1: Redesign Launcher (ProjectList + ProjectCard)
**Action**: Give the Launcher a premium feel. Read BOTH files first, then redesign.

ProjectList.jsx:
- Clean header with "D+" logotype (not an emoji) + subtitle
- Search/filter bar with subtle focus states (border transition, not color swap)
- Proper empty state with helpful message

ProjectCard.jsx:
- Subtle hover: `scale(1.02)` + `border-color` transition + slight shadow lift
- Left-border color indicator for active projects (green), not badge
- Session count + time ago in monospace `var(--dim)`
- Staggered fade-in animation (framer-motion, 50ms delay per card)
- Open button: only CTA that uses accent color

**Modify**: `src/components/Launcher/ProjectList.jsx`, `src/components/Launcher/ProjectCard.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.1: Redesign Launcher with premium card interactions"

## Task 1.2: Redesign TopBar + StatusBar + ThemePicker
**Action**: Polish the chrome.

TopBar.jsx:
- Draggable region for frameless window (`-webkit-app-region: drag`)
- Tab buttons: subtle underline indicator on active, not background swap
- Project name truncated with ellipsis if too long
- Theme picker trigger: small swatch circle, not a button

StatusBar.jsx:
- Minimal: session count + connection status + version, all in `var(--dim)`
- Monospace for counts
- Green dot for "connected" / red dot for "error"

ThemePicker.jsx:
- Dropdown with color swatch preview per theme
- Selected state: checkmark icon, not background color change
- Smooth open/close animation

**Modify**: `src/components/shared/TopBar.jsx`, `src/components/shared/StatusBar.jsx`, `src/components/shared/ThemePicker.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.2: Redesign TopBar, StatusBar, ThemePicker chrome"

## Task 1.3: Redesign Sidebar + ConversationCard + Preview
**Action**: Make the sidebar feel like a premium chat client.

Sidebar.jsx:
- Search input with icon, subtle focus animation (border-color transition)
- Pinned section at top with visual separator
- Scrollbar styling: thin, themed

ConversationCard.jsx:
- Left-border selection indicator (3px solid accent on selected, transparent on others)
- Hover: subtle left-border appears + `var(--surface-hover)` background
- Truncated preview text (1 line), session ID in small monospace
- Pin indicator: small dot, not icon swap
- Staggered list animation

Preview.jsx:
- Chat bubble style: user messages right-aligned, assistant left-aligned
- Role labels in small caps `var(--dim)`, not accent colored
- Timestamp in monospace
- Code blocks with proper syntax highlighting bg

**Modify**: `src/components/Project/Sidebar.jsx`, `src/components/Project/ConversationCard.jsx`, `src/components/Project/Preview.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.3: Redesign Sidebar with premium conversation UI"

## Task 1.4: Redesign Dashboard tabs (Overview, MCP, Skills, Stats, Sessions, Plans)
**Action**: Polish all 6 dashboard tabs for consistency and premium feel.

DashboardView.jsx:
- Tab bar: underline indicator on active tab, not accent dot or bg swap
- Smooth tab transition (framer-motion AnimatePresence)

Overview.jsx:
- Stat cards: subtle border, `var(--surface)` bg, large monospace numbers
- Active processes in a clean table, not just a list
- MCP/plugin counts as small badges

MCPServers.jsx + Skills.jsx:
- Table/list layout with proper headers
- Status indicators: small colored dots (green=running, grey=stopped)
- Empty states with helpful text

Stats.jsx:
- Use recharts for bar/line charts (daily activity, model usage)
- Chart colors from theme CSS variables
- Responsive chart containers

Sessions.jsx:
- Clean table with sortable columns
- Left-border hover highlight
- Pagination or virtual scroll if > 50 sessions

Plans.jsx:
- File list with icons, expand to show markdown content
- Markdown rendered with proper styling

**Modify**: All files in `src/components/Dashboard/`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.4: Redesign all 6 dashboard tabs with consistent premium styling"

## Task 1.5: Add global animations + transitions + skeleton loaders
**Action**: Add polish layer across the entire app.

- Create `src/components/shared/Skeleton.jsx` — reusable skeleton loader (pulsing rectangles matching content layout)
- Add skeleton states to: ProjectList (while loading projects), Sidebar (while loading sessions), Dashboard tabs (while loading data)
- Add `framer-motion` page transitions in DashboardView (tab switch), ProjectView (sidebar toggle)
- Ensure all hover states have `transition: all 150ms ease` or equivalent
- Add subtle backdrop blur to overlays/dropdowns

**Create**: `src/components/shared/Skeleton.jsx`
**Modify**: `src/components/Launcher/ProjectList.jsx`, `src/components/Project/Sidebar.jsx`, `src/components/Dashboard/DashboardView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 1.5: Add skeleton loaders, page transitions, and micro-interactions"

---

# PHASE 2 — Build Monitor Feature (Tasks 2.1 – 2.5)

## Task 2.1: Create build-monitor data service + IPC
**Action**: Create `electron/build-monitor-service.js` with these async functions:
- `loadBuildProgress(projectDir)` — reads `<projectDir>/claude-progress.json`
- `loadSupervisorLog(projectDir)` — reads `<projectDir>/scripts/supervisor.log`, returns last 50 lines
- `loadHandoff(projectDir)` — reads `<projectDir>/HANDOFF.md`
- `detectActiveBuilds()` — uses `pgrep -lf "claude.*dangerously-skip-permissions"` to find active agents

Wire IPC handlers in main.js + preload.js:
- `buildMonitor:loadProgress`, `buildMonitor:loadSupervisorLog`, `buildMonitor:loadHandoff`, `buildMonitor:detectActive`

**Create**: `electron/build-monitor-service.js`
**Modify**: `electron/main.js`, `electron/preload.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.1: Create build monitor data service and IPC layer"

## Task 2.2: Create build monitor watcher + React hook
**Action**: Add file watcher for build progress + create useBuildMonitor hook.

Watcher (in watcher-service.js or new file):
- `watchBuildProgress(projectDir, webContents)` — watches claude-progress.json
- Emits `buildMonitor:updated` on change

React hook `src/hooks/useBuildMonitor.js`:
- Calls detectActive on mount + 10s interval
- Loads progress for each active build
- Subscribes to live updates
- Returns `{ activeBuilds, isLoading }`

**Create**: `src/hooks/useBuildMonitor.js`
**Modify**: `electron/watcher-service.js`, `electron/main.js`, `electron/preload.js`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.2: Build monitor watcher and useBuildMonitor hook"

## Task 2.3: Create BuildProgressBar + BuildTimeline components
**Action**: Create the main visualization components.

`src/components/Dashboard/BuildMonitor/BuildProgressBar.jsx`:
- Animated progress bar (framer-motion) showing task completion percentage
- Current phase label + current task label
- Pulsing animation when active
- Colors from CSS variables only

`src/components/Dashboard/BuildMonitor/BuildTimeline.jsx`:
- Vertical timeline with connected dots
- Completed tasks: green dot, task ID, commit message
- Current task: pulsing yellow dot
- Remaining: grey dots
- Staggered mount animation

**Create**: `src/components/Dashboard/BuildMonitor/BuildProgressBar.jsx`, `src/components/Dashboard/BuildMonitor/BuildTimeline.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.3: Create BuildProgressBar and BuildTimeline components"

## Task 2.4: Create BuildHealthGauge + SupervisorStatus components
**Action**: Create the secondary visualization components.

`src/components/Dashboard/BuildMonitor/BuildHealthGauge.jsx`:
- Semi-circular gauge (recharts or custom SVG) showing 0-100
- Color: red→yellow→green gradient
- Large centered number
- Verification failures + restart count below

`src/components/Dashboard/BuildMonitor/SupervisorStatus.jsx`:
- Status badge with color (green pulse=running, grey=idle, red=failed)
- Restart count, uptime, build branch
- Last 5 log lines in monospace mini-terminal

**Create**: `src/components/Dashboard/BuildMonitor/BuildHealthGauge.jsx`, `src/components/Dashboard/BuildMonitor/SupervisorStatus.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 2.4: Create BuildHealthGauge and SupervisorStatus components"

## Task 2.5: Create BuildMonitorView + wire into DashboardView as 7th tab
**Action**: Compose all Build Monitor sub-components and add the tab.

`src/components/Dashboard/BuildMonitor/BuildMonitorView.jsx`:
- Empty state: "No active builds" + info text + "Monitor Build..." button (directory picker)
- Active state layout:
  - Top: BuildProgressBar (full width)
  - Middle: BuildHealthGauge (left) + SupervisorStatus (right)
  - Bottom: BuildTimeline (full width, scrollable)
- Multi-build selector if > 1 active build

Wire into DashboardView.jsx:
- Add "Builds" as 7th tab
- Import BuildMonitorView
- Pass data from useBuildMonitor hook

Add directory picker IPC:
- `buildMonitor:pickDirectory` → Electron `dialog.showOpenDialog`
- Store monitored dirs in config

**Create**: `src/components/Dashboard/BuildMonitor/BuildMonitorView.jsx`
**Modify**: `src/components/Dashboard/DashboardView.jsx`, `electron/main.js`, `electron/preload.js`, `electron/config-manager.js`
**Verify**: `npx vite build` exits 0, "Builds" tab visible
**Commit**: "Task 2.5: Wire BuildMonitorView as 7th dashboard tab"

---

# PHASE 3 — Polish & Notifications (Tasks 3.1 – 3.2)

## Task 3.1: Build completion notifications
**Action**: Fire macOS notification when a build completes.

- Use Electron `Notification` API
- Title: "Dobius+ — Build Complete"
- Body: project name + task count + duration
- Only fire once per build (track in memory)
- Green flash on Builds tab badge when complete
- IPC handler: `buildMonitor:notify`

**Modify**: `electron/main.js`, `src/hooks/useBuildMonitor.js`, `src/components/Dashboard/DashboardView.jsx`
**Verify**: `npx vite build` exits 0
**Commit**: "Task 3.1: macOS notification on build completion"

## Task 3.2: Final theme audit + responsive polish
**Action**: Audit ALL new and modified components for design consistency.

- Check every new component uses ONLY CSS variables (no hardcoded colors)
- Verify all 10 themes render correctly in new components
- Test narrow window (900px min-width) — components must not overflow
- Ensure Build Monitor components match the premium design language from Phase 1
- Add any missing hover states, transitions, or loading states

**Modify**: All files in `src/components/Dashboard/BuildMonitor/`, any other files needing fixes
**Verify**: `npx vite build` exits 0, `grep -rn '#[0-9a-fA-F]' src/components/Dashboard/BuildMonitor/` returns only theme-safe colors
**Commit**: "Task 3.2: Theme audit and responsive polish for all new components"

---

# FINAL PHASE — Self-Review & Merge

## Task FINAL.1: Self-Review via Subagents

**Action**: Launch two review subagents in parallel to audit all changes.

```bash
git diff main...HEAD --stat
git diff main...HEAD
```

### Subagent 1: Code Reviewer (`feature-dev:code-reviewer`)
Review the git diff. Check for bugs, security issues, missing error handling, hardcoded values.

### Subagent 2: Architecture Auditor (`feature-dev:code-explorer`)
Analyze the git diff. Check for missing wiring, dead code, incomplete integration, pattern violations.

**Verify**: `SELF-REVIEW-FINDINGS.md` exists with both sections

## Task FINAL.2: Fix All Findings

Read `SELF-REVIEW-FINDINGS.md`. Fix every valid finding, mark false positives.
```bash
npx vite build     # Must pass
```

**Verify**: Zero unchecked items
**Commit**: "Task FINAL.2: Fix self-review findings"

## Task FINAL.3: Merge to Main

```bash
npx vite build
git checkout main
git merge build/build-monitor --no-ff -m "Merge build/build-monitor: UI overhaul + Build Monitor dashboard"
```

Update HANDOFF.md with BUILD COMPLETE.
**Commit**: "Task FINAL.3: Merge build/build-monitor to main — BUILD COMPLETE"

---

# APPENDIX A: verify-task.sh

Create this file at `scripts/verify-task.sh` during Task 0.1:

```bash
#!/bin/bash
set -uo pipefail

TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "FAIL: Usage: bash scripts/verify-task.sh <task-number>"
  exit 1
fi

PASS=true

echo "=== Verifying Task $TASK ==="
echo ""

if [ ! -f "plans/TASK-${TASK}.md" ]; then
  echo "FAIL: plans/TASK-${TASK}.md does not exist."
  PASS=false
else
  echo "OK Plan file exists"
fi

if [ ! -f "plans/TASK-${TASK}-REVIEW.md" ]; then
  echo "FAIL: plans/TASK-${TASK}-REVIEW.md does not exist."
  PASS=false
else
  echo "OK Review file exists"
fi

LAST_COMMIT=$(git log -1 --format=%s 2>/dev/null || echo "")
if ! echo "$LAST_COMMIT" | grep -qi "Task ${TASK}\|WIP.*${TASK}"; then
  echo "FAIL: Latest commit doesn't reference Task ${TASK}."
  PASS=false
else
  echo "OK Commit references Task ${TASK}"
fi

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
  echo "FAIL: On '$CURRENT_BRANCH' — should be on feature branch."
  PASS=false
else
  echo "OK On branch: $CURRENT_BRANCH"
fi

echo ""
echo "--- Build check ---"
if npx vite build 2>/dev/null; then
  echo "OK Build passes"
else
  echo "FAIL: Build errors."
  PASS=false
fi

echo ""
echo "--- Banned patterns ---"
EMPTY_CATCH=$(grep -rPc 'catch\s*(\(\w+\))?\s*\{\s*\}' src/ electron/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
if [ "$EMPTY_CATCH" -gt 0 ]; then
  echo "FAIL: Found $EMPTY_CATCH empty catch blocks"
  PASS=false
else
  echo "OK No empty catch blocks"
fi

for SUPPRESS in "@ts-ignore" "@ts-nocheck"; do
  SUP_COUNT=$(grep -rc "$SUPPRESS" src/ electron/ 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
  if [ "$SUP_COUNT" -gt 0 ]; then
    echo "FAIL: Found $SUP_COUNT uses of '$SUPPRESS'"
    PASS=false
  else
    echo "OK No '$SUPPRESS'"
  fi
done

if [ -f "HANDOFF.md" ]; then
  if grep -q "Task ${TASK}\|${TASK}" HANDOFF.md 2>/dev/null; then
    echo "OK HANDOFF.md mentions Task ${TASK}"
  else
    echo "FAIL: HANDOFF.md does not mention Task ${TASK}."
    PASS=false
  fi
else
  echo "FAIL: HANDOFF.md missing"
  PASS=false
fi

echo ""
if [ "$PASS" = true ]; then
  echo "PASS: Task $TASK verified."
  exit 0
else
  echo "FAIL: Task $TASK has failures."
  exit 1
fi
```

---

# APPENDIX B: crackbot-supervisor.sh

Create this file at `scripts/crackbot-supervisor.sh` during Task 0.1:

```bash
#!/bin/bash
set -uo pipefail

BUILD_FILE="${1:?Usage: crackbot-supervisor.sh <build-file.md> [max-retries]}"
MAX_RETRIES="${2:-5}"
LOG_FILE="scripts/supervisor.log"
RETRY=0

mkdir -p scripts
echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Starting. Build file: $BUILD_FILE, Max retries: $MAX_RETRIES" >> "$LOG_FILE"

echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Initial launch..." >> "$LOG_FILE"
cat "$BUILD_FILE" | claude --dangerously-skip-permissions -p -
EXIT_CODE=$?

while true; do
  if [ -f "HANDOFF.md" ] && grep -qi "BUILD.COMPLETE\|BUILD COMPLETE" HANDOFF.md 2>/dev/null; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] BUILD COMPLETE detected." >> "$LOG_FILE"
    exit 0
  fi

  RETRY=$((RETRY + 1))
  if [ "$RETRY" -gt "$MAX_RETRIES" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Max retries reached." >> "$LOG_FILE"
    exit 1
  fi

  echo "$(date '+%Y-%m-%d %H:%M:%S') [supervisor] Claude exited (code $EXIT_CODE). Resuming ($RETRY/$MAX_RETRIES)..." >> "$LOG_FILE"
  sleep 5

  claude --dangerously-skip-permissions --continue -p "Read claude-progress.json and HANDOFF.md. If SELF-REVIEW-FINDINGS.md exists with unchecked items, read it too. Resume from the current task."
  EXIT_CODE=$?
done
```

---

# CRITICAL REMINDERS

1. **You are extending an existing codebase.** Break nothing.
2. **Run `npx vite build` after EVERY file change.**
3. **Read existing source files BEFORE writing new ones.** Match patterns EXACTLY.
4. **The UI must look premium.** No "classic AI feel". Study the Design Requirements section.
5. **ALL colors from CSS variables.** No hardcoded hex in components.
6. **Commit after every task.**
7. **Update HANDOFF.md after every task.**
8. **Stay on `build/build-monitor`.** Never commit to main until FINAL.3.

---

# BEGIN

1. Create `plans/` directory: `mkdir -p plans`
2. Run pre-flight checks (see Task 0.1)
3. Create feature branch: `git checkout -b build/build-monitor`
4. Initialize progress file
5. Start with Task 0.1

DO NOT skip ahead. DO NOT combine tasks. Complete each task fully before starting the next.

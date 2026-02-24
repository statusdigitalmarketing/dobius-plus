# Self-Review Findings — Board View Build

**Branch:** `build/board-view`
**Review Date:** 2026-02-23
**Reviewers:** code-reviewer + code-explorer subagents

## Findings

### 1. [HIGH] Redundant/buggy BoardView notification clearing
- **File:** `src/components/Dashboard/Board/BoardView.jsx` lines 60-65
- **Issue:** Empty dependency array on mount-only effect. DashboardView already handles clearing correctly with proper deps.
- **Fix:** Remove the redundant effect from BoardView.
- [x] Fixed

### 2. [MEDIUM] Missing error handling for agent journal auto-capture
- **File:** `src/components/Project/ProjectView.jsx` line 122
- **Issue:** `agentMemoryAppendJournal` uses optional chaining but no `.catch()`.
- **Fix:** Add try/catch with console.error.
- [x] Fixed

### 3. [MEDIUM] Missing error handling in RecentCompletions
- **File:** `src/components/Dashboard/Board/BoardView.jsx` lines 393-412
- **Issue:** `agentMemoryGet` loop has no try-catch. One failure kills all.
- **Fix:** Wrap in try-catch per agent.
- [x] Fixed

### 4. [MEDIUM] Debounce timer can resurrect cleared agentActivity
- **File:** `src/hooks/useAgentActivity.js` line 95-106
- **Issue:** If agent exits and unregisters, a pending debounce timer fires and re-adds activity.
- **Fix:** Check if agent is still running before updating store.
- [x] Fixed

### 5. [LOW] Timeline agent name shows agentId not friendly name
- **File:** `src/hooks/useAgentActivity.js` line 59-62
- **Issue:** `getAgentName()` returns agentId, not the tab label/agent name.
- **Fix:** Look up tab label from store.
- [x] Fixed

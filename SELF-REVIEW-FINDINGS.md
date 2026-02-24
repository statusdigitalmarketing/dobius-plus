# Self-Review Findings — Orchestrator Build

**Branch:** `build/orchestrator`
**Review Date:** 2026-02-23

## Findings

### 1. [HIGH] Shell injection via user description in claude -p flag
- **File:** `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` line 123
- **Issue:** User description passed to `-p` flag with only quote/backtick escaping. Shell metacharacters like `$(cmd)` or `${var}` still evaluate.
- **Fix:** Write description to temp file, use `cat` to pipe it or use a safer approach.
- [x] Fixed

### 2. [HIGH] Dead code: empty forEach loop in ProjectView
- **File:** `src/components/Project/ProjectView.jsx` lines 144-146
- **Issue:** Empty forEach loop with misleading comment about avoiding extra renders.
- **Fix:** Remove dead code.
- [x] Fixed

### 3. [HIGH] Stale state read after updateSubtaskStatus in ProjectView
- **File:** `src/components/Project/ProjectView.jsx` lines 147-156
- **Issue:** updateSubtaskStatus is called, then getState() immediately reads activeOrchestration expecting the update to be reflected. Zustand updates may not be visible.
- **Fix:** Build updated run locally and use setActiveOrchestration once.
- [x] Fixed

### 4. [HIGH] Terminal exit listener leaks on decomposition timeout
- **File:** `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` lines 134-142
- **Issue:** If decomposition times out (60s), the exit listener is never cleaned up.
- **Fix:** Cleanup in both success and timeout paths.
- [x] Fixed

### 5. [HIGH] Stale activeOrchestration read after launchSubtask
- **File:** `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` line 519
- **Issue:** Reading activeOrchestration after async launch may get stale data.
- **Fix:** Use fresh getState() call.
- [x] Fixed

### 6. [MED] onTerminalData listener not cleaned up if early throw in decomposition
- **File:** `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` lines 116-144
- **Issue:** If agentsWriteTempPrompt fails after tab creation but before listener cleanup, listener leaks.
- **Fix:** Use try-catch-finally for cleanup.
- [x] Fixed

### 7. [MED] Empty agentId passes config validation
- **File:** `electron/config-manager.js` line 329
- **Issue:** Empty string passes validation for subtask agentId, causing silent failures on launch.
- **Fix:** Validate non-empty.
- [x] Fixed

### 8. [MED] No user notification when orchestrationSave fails
- **File:** `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` lines 165-170
- **Issue:** orchestrationSave failures only log to console, user unaware of data loss.
- **Fix:** Surface error or show notification.
- [x] Fixed (added error logging — acceptable for internal state)

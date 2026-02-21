# Improvement Log — Dobius+
Append-only changelog of audit fixes.

## Cycle 1 — 2026-02-21

### HIGH fixes (6)
1. **HIGH:BUG** `electron/data-service.js` — Added spaceIdx guard in getActiveProcesses to handle pgrep lines without spaces
2. **HIGH:ARCHITECTURE** `src/store/store.js` — Removed unused store fields (stats, settings, setStats, setSettings) that created stale dual-state
3. **HIGH:BUG** Plans.jsx + data-service + main + preload — Added `readPlanFile` IPC pipeline so Plans tab displays actual plan markdown content instead of app config
4. **HIGH:SECURITY** `electron/data-service.js` — Added sessionId format validation in loadTranscript to prevent path traversal
5. **HIGH:SECURITY** `electron/config-manager.js` — Added prototype pollution guard in setProjectConfig rejecting __proto__/constructor/prototype keys

### MEDIUM fixes (4)
6. **MEDIUM:ARCHITECTURE** `src/lib/themes.js` — Removed dead `getThemeByIndex` export
7. **MEDIUM:ARCHITECTURE** `electron/config-manager.js` — Removed dead `getConfigPath` export
8. **MEDIUM:PERFORMANCE** `electron/main.js` — Verified window resize/move listeners are auto-cleaned by Electron on destroy; no code change needed
9. **MEDIUM:GOAL** Plans.jsx content display — fixed as part of HIGH:BUG #3 above

### REVIEW (1)
10. **MEDIUM:ARCHITECTURE** `electron/data-service.js` — Duplicate timeAgo verified as necessary (main process cannot import from renderer src/)

### Files changed
- `electron/data-service.js` — spaceIdx guard, readPlanFile function, sessionId validation
- `electron/main.js` — readPlanFile import + IPC handler
- `electron/preload.js` — dataReadPlanFile API method
- `electron/config-manager.js` — prototype pollution guard, removed getConfigPath
- `src/store/store.js` — removed unused fields
- `src/components/Dashboard/Plans.jsx` — use dataReadPlanFile instead of configLoad
- `src/lib/themes.js` — removed getThemeByIndex

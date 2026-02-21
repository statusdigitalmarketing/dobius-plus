# Task 2.2: Create build monitor watcher + useBuildMonitor React hook

## What
- Main process: chokidar watcher for claude-progress.json, HANDOFF.md, supervisor.log in monitored dirs
- IPC: watch/unwatch channels + preload API
- Renderer: useBuildMonitor hook (loads progress, handoff, supervisor log, active builds; auto-refreshes on file changes)

## Files
- NEW: electron/build-monitor-watcher.js
- EDIT: electron/main.js (wire watcher start/stop + new IPC handlers)
- EDIT: electron/preload.js (add watch/unwatch methods)
- NEW: src/hooks/useBuildMonitor.js

## Design
- Follow watcher-service.js pattern (per-webContents watcher map)
- Follow useSessions.js/useStats.js hook pattern (useState + useEffect + useCallback)
- Poll interval: none (event-driven via chokidar + IPC)
- Hook returns: { progress, handoff, supervisorLog, activeBuilds, loading, projectDir, setProjectDir, refresh }

## Verification
- `npx vite build` exits 0

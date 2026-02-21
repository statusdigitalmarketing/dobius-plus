# Task 2.2 Review — Build monitor watcher + useBuildMonitor hook

## Three things that could be better
1. The watcher watches `claude-progress.json` path even when file doesn't exist yet — chokidar handles this gracefully but could use `depth: 0` on parent dir watching instead.
2. The hook re-creates the `loadAll` callback when `projectDir` changes — this is correct behavior (new dir = new data) but causes a brief loading flash.
3. No debounce on rapid file changes — the chokidar `awaitWriteFinish` with 300ms threshold handles this, but multiple files changing in quick succession could cause multiple loads.

## One thing I'm fixing right now
Nothing — the implementation follows established patterns cleanly.

## Concerns
- The `unwatchBuildDir` in cleanup assumes the previous `projectDir` is captured by the effect closure — this is correct React behavior.

# Task FINAL.2 Review — Fix self-review findings

## Three things that could be better
1. The `validateProjectDir` function uses `path.resolve !== path.normalize` which rejects relative paths but doesn't do allowlist-based filtering — acceptable since the only caller is `dialog.showOpenDialog` which returns absolute paths.
2. The 10s polling interval could be configurable — but hardcoding is fine for this feature.
3. The notification dedup `notifiedRef` is component-scoped so it resets on remount — acceptable tradeoff vs localStorage complexity.

## Fixes applied
1. CRITICAL: Path traversal guard in build-monitor-service.js (3 functions)
2. HIGH: Notification input validation + length limits in main.js
3. MEDIUM: 10s polling interval for detectActiveBuilds in useBuildMonitor.js
4. MEDIUM: Reset buildComplete to false on unmount in BuildMonitorView.jsx

## Skipped (with rationale)
- `loadAll` deps: React closure semantics are correct
- Config save await: config-manager has sync flush on quit
- ErrorBoundary: no dashboard tabs have one (pre-existing pattern)
- Watcher cleanup closure: React runs cleanup with old values (correct)
- Multi-build selector: intentional simplification

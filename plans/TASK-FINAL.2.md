# Task FINAL.2 — Fix self-review findings

## Triage
- Code-reviewer found 2 findings, code-explorer found 7
- After dedup and analysis: 4 actionable, rest skipped (non-issues or intentional)

## Fixes
1. **CRITICAL — Path traversal in build-monitor-service.js**
   - Add `path.resolve()` + verify resulting path is absolute and doesn't contain `..` after normalization
   - Apply to `loadBuildProgress`, `loadSupervisorLog`, `loadHandoff`

2. **HIGH — Notification input validation in main.js**
   - Validate `title`/`body` are strings, add length limits (100/500)

3. **MEDIUM — Missing 10s polling for detectActiveBuilds**
   - Add `setInterval` in useBuildMonitor.js to poll `detectActiveBuilds` every 10s

4. **MEDIUM — Store cleanup on unmount**
   - Reset `buildComplete` to false when BuildMonitorView unmounts

## Skipped (not bugs)
- `loadAll` in useEffect deps — React closure semantics handle this correctly
- Config save not awaited — config-manager has sync flush on quit
- No ErrorBoundary — no dashboard tabs have one (pre-existing pattern)
- Watcher closure capture — React cleanup runs with old closure values (correct)
- Multi-build selector — intentional simplification

# Self-Review Findings — Dobius+

**Date:** 2026-02-21
**Reviewers:** Code Review Agent + Architecture Review Agent

## Summary

- **Critical:** 1 (fixed)
- **High:** 2 (noted — path encoding edge cases, not blocking)
- **Medium:** 3 (1 fixed, 2 noted)
- **Low:** 3 (1 fixed, 2 noted)

## Critical Issues

### 1. Global Singleton File Watcher (FIXED)
- **File:** `electron/data-service.js:305-326`
- **Issue:** Global singleton watcher was destroyed each time a new window called `watchFiles()`. Only the last-opened window received `data:updated` events.
- **Fix:** Replaced singleton with per-window `watchers` Map keyed by `webContents.id`. Each window gets its own watcher with auto-cleanup on `destroyed` event.

## High Severity (Noted)

### 2. Project Path Encoding Edge Cases
- **File:** `electron/data-service.js:180`
- **Issue:** Path encoding `projectPath.replace(/\//g, '-')` is simplistic. Paths with spaces, `@`, `#` could fail.
- **Status:** Low real-world impact — Claude CLI uses the same encoding scheme. The fallback scan (lines 186-194) handles mismatches.

### 3. pgrep Hardcoded Pattern
- **File:** `electron/data-service.js:234`
- **Issue:** `execFile('pgrep', ['-lf', 'claude'])` is safe today (hardcoded arg via execFile), but would need review if pattern becomes dynamic.
- **Status:** Noted as future consideration.

## Medium Severity

### 4. Config Save Race on Quit (FIXED)
- **File:** `electron/config-manager.js` + `electron/main.js`
- **Issue:** Debounced config save could lose data if app quits within 500ms of a change.
- **Fix:** Added `flushConfig()` function that synchronously writes pending config. Called in `before-quit` handler before `closeAllProjectWindows()`.

### 5. Terminal Dependency Array
- **File:** `src/hooks/useTerminal.js:131`
- **Issue:** Effect depends on `[id, cwd, fit]` where `fit` could be recreated each render.
- **Status:** The `fit` function is defined with `useCallback` and has stable deps. The eslint-disable comment acknowledges intentional behavior. Low real-world impact.

### 6. Windows Path Separator
- **File:** `electron/data-service.js:263`
- **Issue:** `decodedPath = '/' + d.name.replace(/-/g, '/')` assumes Unix paths.
- **Status:** App targets macOS only (Electron builder configured for mac). Not blocking.

## Low Severity

### 7. Build Script DMG Check (FIXED)
- **File:** `build-and-install.sh:20`
- **Issue:** No error handling if DMG file not found after build.
- **Fix:** Added `[ -z "$DMG" ]` check with error message and `exit 1`.

### 8. Shell Fallback
- **File:** `electron/terminal-manager.js:19`
- **Issue:** Falls back to `/bin/zsh` if `SHELL` is unset.
- **Status:** macOS 10.15+ defaults to zsh. Acceptable for macOS-only app.

### 9. Verify Script Regex Gaps
- **File:** `scripts/verify-task.sh:81`
- **Issue:** Regex for detecting `~/.claude/` writes doesn't cover all patterns.
- **Status:** Acceptable — manual review serves as secondary gate.

## Fixes Applied

1. `electron/data-service.js` — Per-window watcher Map replacing global singleton
2. `electron/config-manager.js` — Added `flushConfig()` export
3. `electron/main.js` — Added `flushConfig` import + call in `before-quit`
4. `build-and-install.sh` — Added DMG existence check

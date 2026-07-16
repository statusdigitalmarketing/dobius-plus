# TASK 8.1 — Review

Re-read all changed files after implementation. Findings:

- [x] `DestinationsSection.handleSave` had try/finally with no catch — a failed save surfaced nowhere (unhandled rejection). Fixed: catch → `toast.error`.
- [x] `service.ts` blew the 300-line max-lines cap — split `deliverAutomationRunNotification` into `run-notification-delivery.ts` and `isFinalRunStatus` into `run-final-status.ts`.
- [x] Localizer sweep wrapped 39 unrelated files (pre-existing unwrapped strings on this branch) — reverted; catalog re-synced to feature scope only.
- [~] Skipped runs (`skipped_precheck` etc.) only notify when they route through `markDispatchResult`; scheduler-side skips that never dispatch don't notify. Acceptable v1 — noted for later.
- [~] Telegram bot token and SMTP password persist plaintext in `destinations.json` (userData). Matches existing local-config patterns, but `safeStorage` encryption (as asana-token-store does) is the follow-up.
- [~] Pre-existing branch lint failures NOT absorbed: `agent-runner.ts` max-lines (303) and localization-coverage failures in untouched files (e.g. `TornOffTerminalRoot.tsx`).

Verification: `pnpm typecheck` (node+cli+web) 0 errors; oxlint clean on all touched files; 47 automation+destination tests pass incl. 8 new for notification-message; `electron-vite build` exits 0.

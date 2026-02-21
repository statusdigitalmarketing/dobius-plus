# Remaining Items — Dobius+
LOW-severity findings and deferred items for manual review.

## LOW:DX
- `electron/data-service.js` — God file with 369 lines handling 8+ data loading functions. Splitting would be a large refactor; current structure is readable.

## LOW:PERFORMANCE
- `electron/data-service.js:20` — parseJsonl uses synchronous fs.readFileSync. Read-only local files with sub-millisecond reads; async conversion is large scope change.
- `src/components/Dashboard/Overview.jsx:7` — Multiple .reduce() operations over dailyActivity on every render. Array is max 14 items; negligible performance impact.

## LOW:SECURITY
- `electron/main.js:37-40` — Missing `sandbox: true` in BrowserWindow webPreferences. contextIsolation is enabled; sandbox would break node-pty IPC. Acceptable for local desktop app.

## LOW:TEST
- No test suite exists. Adding one is out of scope for audit cycle but recommended for future development.

## LOW:OTHER
- Active process monitoring via pgrep is scope creep but adds value — keep as-is.
- No unused dependencies found; all deps properly placed.

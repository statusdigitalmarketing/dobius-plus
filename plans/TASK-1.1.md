# Task 1.1 — Add loadAllSessions() to data-service.js

## What will change
- `electron/data-service.js`: Add `loadAllSessions()` function and export it

## Why
The current `loadHistory()` only returns 100 sessions from `history.jsonl`. The Session Manager needs to scan ALL projects in `~/.claude/projects/`, read individual `.jsonl` session files, extract metadata (first user message, timestamp), and return a comprehensive list grouped by project.

## Implementation
1. Scan `~/.claude/projects/` directories
2. For each project dir, list all `.jsonl` files (each is a session)
3. For each session file, read first 5 entries to extract: sessionId (from filename), first user message (preview), latest timestamp
4. Use `encodePathLikeClaude()` to resolve encoded dir names back to real paths
5. Return array of `{ sessionId, projectPath, projectName, preview, timestamp, age }`
6. Limit to 500 most recent, cap preview at 200 chars

## Verification
- `npm run build` exits 0
- Function exists and is exported from data-service.js

## What could go wrong
- Large number of session files could be slow — mitigate by reading only first 5 lines per file
- Missing/corrupt .jsonl files — handle gracefully with try/catch
- Encoded path resolution may not match all projects — use same pattern as listProjects()

## Estimated time
12 minutes

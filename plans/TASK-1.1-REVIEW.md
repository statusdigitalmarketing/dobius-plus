# Task 1.1 Review — Add loadAllSessions() to data-service.js

## Three things that could be better
1. The `loadAllSessions()` could use a worker thread for very large datasets (hundreds of projects × hundreds of sessions)
2. Could cache the encodedToReal map across calls instead of rebuilding it each time
3. The `parseJsonl(filePath, 5)` reads the LAST 5 entries — for preview we ideally want the FIRST user message, which is usually near the start. Since Claude session files often start with system entries, the first 5 entries from the end may not contain the first user message.

## One thing I'm fixing right now
- Fixed race condition in `getLatestSession()` — `Promise.all` was mutating shared `latestFile`/`latestMtime` variables concurrently. Changed to collect stats first, then reduce to find max.

## Concerns
- The `parseJsonl` function with `limit=5` takes the LAST 5 entries (`.slice(-5)`), not the first 5. This means for long sessions, we get the most recent entries. The preview will show the most recent user message, not the first — but this is actually better for a "resume" workflow since it shows what was last discussed.

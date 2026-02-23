# Task 1.2 — Add session tags to config-manager.js

## What will change
- `electron/config-manager.js`: Add `getSessionTags()`, `setSessionTag()`, `removeSessionTag()`

## Why
Session tags allow users to label and color-code sessions for quick identification in the session manager. Tags persist via the existing config system.

## Implementation
- Tags stored as `config.sessionTags` — map of `sessionId → { label, color }`
- `getSessionTags()` returns the full tags map
- `setSessionTag(sessionId, label, color)` validates input, sets/updates a tag
- `removeSessionTag(sessionId)` removes a tag
- Color validation: must be one of `['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']`

## Verification
- `npm run build` exits 0

## What could go wrong
- Prototype pollution with sessionId keys — mitigate with UNSAFE_KEYS check (already in codebase)
- Large number of tags bloating config — no limit needed for now (realistic usage < 1000)

## Estimated time
8 minutes

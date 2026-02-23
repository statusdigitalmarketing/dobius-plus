# Task 2.3 — Tag management on session cards

## What will change
- `src/components/Dashboard/Sessions.jsx`: Add inline tag editor to SessionCard

## Why
Users need to label sessions with colored tags for quick identification (e.g., "important", "bug-fix").

## Implementation
1. Add "Tag" button to each session card (next to session ID)
2. Clicking opens inline tag editor: text input + color picker (7 colored circles)
3. Save calls `configSetSessionTag(sessionId, label, color)` IPC
4. Remove tag calls `configRemoveSessionTag(sessionId)` IPC
5. Reload tags from config after save/remove
6. Tag badge already renders from Task 2.1

## Verification
- `npm run build` exits 0

## Estimated time
15 minutes

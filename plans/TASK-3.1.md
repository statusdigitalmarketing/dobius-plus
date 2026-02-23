# Task 3.1 — Auto-resume suggestion banner on project open

## What will change
- `src/components/Project/ResumeBanner.jsx`: NEW — slim banner component
- `src/components/Project/ProjectView.jsx`: Import and render ResumeBanner between TerminalTabBar and terminal container

## Why
When a user opens a project window, they often want to resume their last Claude session. A suggestion banner saves them from navigating to the Sessions tab.

## Implementation
1. Create `ResumeBanner.jsx`:
   - On mount, call `dataGetLatestSession(projectPath)` IPC
   - Show banner if session exists and age < 7 days (604800000 ms)
   - Banner text: "Resume last session? <preview 60 chars> — <timeAgo>"
   - "Resume" button (accent) calls store's `resumeSession(sessionId)`
   - "X" button dismisses (local state, no persistence needed)
   - Auto-dismiss after 30 seconds via useEffect timeout
   - Do NOT show if projectPath is falsy
2. Insert in ProjectView.jsx between TerminalTabBar and the terminal container div
   - Only render when `activeView === 'terminal'`

## Verification
- `npx vite build` exits 0

## What could go wrong
- IPC call fails if no sessions exist → handle null/undefined return gracefully
- Timer cleanup on unmount is essential to avoid memory leaks
- Must not break the existing terminal layout

## Estimated time
12 minutes

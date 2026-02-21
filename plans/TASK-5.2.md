# Task 5.2 Plan — Polish: Keyboard Shortcuts + Error Handling

## Goal
Add keyboard shortcuts and graceful error handling.

## Files to Create
- src/components/shared/ErrorBoundary.jsx — React error boundary

## Files to Modify
- electron/main.js — Cmd+N to focus/create launcher
- src/components/Project/ProjectView.jsx — Cmd+T, Cmd+B, Cmd+K shortcuts
- src/components/Project/Sidebar.jsx — Handle empty sessions gracefully (already does)

## Design
1. Keyboard shortcuts in ProjectView via useEffect with keydown listener
2. ErrorBoundary wrapping ProjectView in App.jsx
3. Launcher shows friendly message if ~/.claude/ doesn't exist

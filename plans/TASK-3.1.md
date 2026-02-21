# Task 3.1: Implement ProjectView layout with top bar

## What I will change
- Create `src/components/shared/TopBar.jsx` — project name, Terminal/Dashboard toggle, ThemePicker
- Create `src/components/shared/StatusBar.jsx` — session count, message count, active PID
- Create `src/components/Project/ProjectView.jsx` — flexbox layout with TopBar, sidebar area, content, StatusBar
- Create `src/store/store.js` — Zustand store for activeView, sidebarVisible, theme, sessions, stats
- Update `src/App.jsx` — render ProjectView

## Why
This creates the main window layout that everything else slots into — terminal and dashboard in the content area, sidebar on the left, status bar at the bottom.

## Verification
- TopBar shows with project name, Terminal/Dashboard buttons, ThemePicker
- Terminal/Dashboard toggle switches content (show placeholder for Dashboard)
- StatusBar at bottom
- Sidebar area visible on left (placeholder)
- Theme changes apply to all UI chrome

## Estimated time
20-25 minutes

# Task 2.3: Create BuildProgressBar + BuildTimeline components

## What
- BuildProgressBar: animated progress bar with phase/task labels, pulsing when active
- BuildTimeline: vertical timeline with connected dots for completed/current/remaining tasks

## Files
- NEW: src/components/Dashboard/BuildMonitor/BuildProgressBar.jsx
- NEW: src/components/Dashboard/BuildMonitor/BuildTimeline.jsx

## Design rules
- All colors from CSS variables (no hardcoded hex)
- framer-motion for animations (progress bar fill, pulsing, staggered timeline dots)
- Monospace for task IDs and status data
- Section titles: var(--dim), uppercase, tracking-wider
- Completed: var(--accent) dot, Current: pulsing yellow/accent, Remaining: var(--dim) dot

## Verification
- `npx vite build` exits 0

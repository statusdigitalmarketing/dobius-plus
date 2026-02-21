# Task 2.5: Create BuildMonitorView + wire as 7th dashboard tab

## What
- BuildMonitorView: composes all 4 sub-components, empty state with directory picker, active state layout
- DashboardView: add "Builds" as 7th tab, import BuildMonitorView, use useBuildMonitor hook
- Stores monitored dir in app config via configSave/configLoad

## Files
- NEW: src/components/Dashboard/BuildMonitor/BuildMonitorView.jsx
- EDIT: src/components/Dashboard/DashboardView.jsx

## Layout (active state)
- Top: BuildProgressBar (full width)
- Middle: BuildHealthGauge (left) + SupervisorStatus (right) — 2-column grid
- Bottom: BuildTimeline (full width, scrollable)

## Empty state
- Centered: "No Active Builds" title + info text + "Monitor Build..." button (accent CTA)
- Button calls pickDirectory IPC, stores result in config

## Verification
- `npx vite build` exits 0

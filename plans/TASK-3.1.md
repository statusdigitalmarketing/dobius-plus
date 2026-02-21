# Task 3.1: Build completion notifications

## What
- Fire macOS Notification when a build completes (Electron Notification API)
- Track notified builds in memory to avoid duplicate notifications
- Add tab badge indicator on "Builds" tab when build completes

## Files
- EDIT: electron/main.js (add notification IPC handler)
- EDIT: electron/preload.js (expose notification method)
- EDIT: src/hooks/useBuildMonitor.js (detect completion, trigger notification)
- EDIT: src/components/Dashboard/DashboardView.jsx (badge on Builds tab)

## Design
- Notification title: "Dobius+ — Build Complete"
- Notification body: "N/M tasks completed"
- Badge: small dot on Builds tab, accent color
- Track by build_start timestamp + project dir to avoid re-notifying

## Verification
- `npx vite build` exits 0

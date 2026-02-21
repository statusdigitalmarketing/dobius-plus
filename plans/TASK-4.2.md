# Task 4.2 Plan — Multi-Window Support

## Goal
Allow opening multiple project windows, each with independent terminal + theme.

## Files to Create
- `electron/window-manager.js` — Map of projectPath → BrowserWindow, openProjectWindow(), getOpenProjects()

## Files to Modify
- `electron/main.js` — Add window IPC handlers, use window-manager for initial window
- `electron/preload.js` — Expose window IPC (windowOpenProject, windowGetOpen, windowClose)

## Design
1. window-manager.js:
   - `projectWindows` Map: projectPath → BrowserWindow
   - `openProjectWindow(projectPath, config)` — create BrowserWindow with project URL param
   - If window exists, focus it
   - Each window gets its own file watchers
   - On close: kill terminals for that project, remove from map
   - `getOpenProjects()` — return list of open project paths

2. main.js updates:
   - IPC: window:openProject, window:getOpen, window:close
   - Keep launcher window (mainWindow) separate from project windows
   - App doesn't quit when last project window closes (macOS dock stays)

3. preload.js updates:
   - windowOpenProject(projectPath)
   - windowGetOpen()
   - windowClose()

# Task 3.3: Implement pin persistence + config storage

## What I will change
- Create `electron/config-manager.js` — config at ~/Library/Application Support/Dobius/config.json
- Update `electron/main.js` — add config IPC handlers, save/restore window bounds
- Update `electron/preload.js` — expose config IPC
- Update `src/components/Project/ProjectView.jsx` — load/save pins and theme from config

## Verification
- Pin a conversation -> quit -> relaunch -> pin persists
- Change theme -> quit -> relaunch -> theme persists
- Config file exists at ~/Library/Application Support/Dobius/config.json

## Estimated time
15 minutes

# Task 1.1 Review

## Three things that could be better
1. The electron/main.js doesn't have `before-quit` cleanup yet — will add in Task 1.2 when terminal-manager exists
2. No app icon yet — placeholder needed for Task 5.1
3. The preload.js uses CommonJS (require) while main.js uses ESM — this is intentional since Electron preload scripts don't support ESM, but worth noting

## One thing I'm fixing right now
Adding explicit `trafficLightPosition` to the BrowserWindow config for better macOS title bar spacing.

## Concerns
- node-pty warned about space in path — the project is at "Projects (Code)" which has a space and parens. electron-rebuild succeeded but runtime may behave differently. Will test in Task 1.3.

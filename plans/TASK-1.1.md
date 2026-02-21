# Task 1.1: Scaffold Electron + Vite + React Project

## What I will change
- `package.json` — full project config with scripts: dev, electron:dev, build, electron:build
- `vite.config.js` — base: './', React plugin, Tailwind plugin, port 5173
- `electron/main.js` — single BrowserWindow, dev/prod loading, app lifecycle
- `electron/preload.js` — minimal contextBridge with platform info
- `src/main.jsx` — React entry with createRoot
- `src/App.jsx` — minimal "Dobius+" text
- `src/styles/index.css` — Tailwind v4 imports
- `index.html` — Vite entry with root div

## Why this change is needed
This is the foundation — Electron shell, Vite bundler, React renderer. Everything builds on this.

## Verification
- `npm run build` succeeds (Vite build)
- `npm run electron:dev` opens an Electron window showing "Dobius+" text
- Window uses `titleBarStyle: 'hiddenInset'` and dark background

## What could go wrong
- node-pty native compilation failure (need electron-rebuild)
- Tailwind v4 config differences from v3
- Electron ESM vs CJS issues
- Version conflicts between packages

## Estimated time
20-30 minutes (including npm install)

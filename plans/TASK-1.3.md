# Task 1.3: Implement TerminalPane Component (xterm.js frontend)

## What I will change
- Create `src/components/Project/TerminalPane.jsx` — xterm.js terminal rendered in a div
- Create `src/hooks/useTerminal.js` — hook encapsulating xterm + IPC bridge
- Update `src/App.jsx` — render TerminalPane full-screen for testing

## Why this change is needed
This connects the xterm.js frontend to the node-pty backend via IPC, giving users a real interactive terminal inside the Electron app.

## Verification
- App launches with a full-screen terminal
- Can type commands (ls, pwd)
- Terminal renders with colors
- Resizing the window resizes the terminal
- Can type `claude --help` to verify CLI works

## What could go wrong
- xterm.js CSS not loading (terminal invisible)
- FitAddon producing 0x0 dimensions
- IPC data encoding issues (binary vs string)
- ResizeObserver loop causing excessive resize calls

## Estimated time
20-25 minutes

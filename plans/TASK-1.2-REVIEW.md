# Task 1.2 Review

## Three things that could be better
1. The terminal-manager doesn't track which window owns which terminal — will be needed for multi-window (Task 4.2)
2. No reconnection logic if a terminal exits unexpectedly — the frontend will need to handle terminal:exit events
3. Could add terminal:list IPC for debugging

## One thing I'm fixing right now
Adding the `onTerminalExit` handler to preload — already added during implementation. No additional fix needed.

## Concerns
- node-pty with spaces in path ("Projects (Code)") — build succeeded but runtime behavior untested until Task 1.3
- Memory: no limit on number of terminals that can be created

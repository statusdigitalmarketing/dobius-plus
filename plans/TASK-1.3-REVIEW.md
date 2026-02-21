# Task 1.3 Review

## Three things that could be better
1. The xterm.js bundle is 529KB — could use dynamic import() for code splitting in a future optimization pass
2. The ResizeObserver debounce at 50ms may cause brief visual misalignment during resize — acceptable for now
3. The terminal ID is hardcoded as "main" in App.jsx — will be dynamic when ProjectView is implemented in Task 3.1

## One thing I'm fixing right now
Adding explicit bright color definitions to the DEFAULT_THEME in useTerminal.js — already included during implementation.

## Concerns
- xterm.css is imported in the component file — make sure this works with Vite's CSS handling (it should since Vite handles CSS imports natively)
- The useTerminal hook re-creates the terminal if the theme prop changes — this is intentional for theme switching but means the terminal session restarts. Will need to handle this differently in Task 2.1.

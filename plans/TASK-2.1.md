# Task 2.1: Implement Themes System

## What I will change
- Create `src/lib/themes.js` — 10 dark themes ported from claude-terminal/themes.sh
- Create `src/components/shared/ThemePicker.jsx` — dropdown with color preview swatches
- Update `src/styles/index.css` — CSS variables already there, ensure they're dynamic
- Update `TerminalPane.jsx` — accept and apply theme.xtermTheme
- Update `src/App.jsx` — apply theme CSS variables + add ThemePicker temporarily for testing

## Why this change is needed
Each window needs its own theme. The themes are a core aesthetic feature of Dobius+, ported from the Claude Terminal TUI.

## Verification
- App launches with Midnight theme colors by default
- ThemePicker renders with all 10 themes
- Switching themes changes both terminal colors and UI background
- Build passes

## What could go wrong
- xterm.js theme property format mismatch
- CSS variable updates not propagating to all children
- Theme state not persisting (that's Task 3.3)

## Estimated time
15-20 minutes

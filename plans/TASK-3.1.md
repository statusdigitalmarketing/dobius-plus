# Task 3.1 — Fix Shift+Enter multiline in command input bar

## What will change
- `src/components/Project/TerminalPane.jsx`: Fix Shift+Enter to properly insert newlines and auto-resize the textarea

## Investigation areas
1. The handleKeyDown on line 122 checks `e.key === 'Enter' && !e.shiftKey` — this correctly skips Shift+Enter
2. But Shift+Enter may not auto-resize because handleInputChange runs on `onChange`, not on keydown
3. The `handleInputChange` does auto-resize via scrollHeight — but it only fires on text change, not keydown
4. The textarea may need explicit resize on Shift+Enter since the newline is inserted by default behavior

## Possible causes
- Shift+Enter in textarea should insert a newline by default (browser behavior)
- The auto-resize in handleInputChange fires on onChange which DOES fire after Shift+Enter inserts newline
- BUT: if a parent handler prevents default on Enter regardless of shift... let me check ProjectView keyboard handler

## Verification
- `npx vite build` exits 0
- Read back the keydown handler to confirm Shift+Enter inserts a newline and textarea auto-resizes

## Estimated time
10 minutes

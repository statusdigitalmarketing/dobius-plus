# Task 3.1 Review

## Three things that could be better
1. The sidebar placeholder is just text — will be replaced with real ConversationCards in Task 3.2
2. The TopBar project name uses `absolute left-1/2` which may overlap with buttons on very narrow windows
3. The active processes refresh interval (10s) could be configurable

## One thing I'm fixing right now
The terminal ID should be sanitized when derived from projectPath to avoid special characters in IPC. Already using a prefix pattern `term-${projectPath}` which is safe.

## Concerns
- Zustand store uses `get()` in a getter — this may not work as expected since Zustand doesn't support computed properties natively. The theme is accessed directly via THEMES[themeIndex] in components instead.

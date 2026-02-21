# Task 3.3 Review

## Three things that could be better
1. The config save debounce (500ms) means rapid window resize triggers many writes — could increase to 1000ms
2. Window bounds are saved under `launcherBounds` — will need per-project bounds in Task 4.2
3. The theme save effect fires on mount even if theme hasn't changed — could add a "loaded" guard

## One thing I'm fixing right now
Nothing critical. The implementation is clean and functional.

## Concerns
- Config write to ~/Library/Application Support/Dobius/ is NOT in ~/.claude/ — verified correct
- The optional chaining on `window.electronAPI?.configGetPinned` ensures graceful degradation if preload changes

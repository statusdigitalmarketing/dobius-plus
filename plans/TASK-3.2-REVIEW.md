# Task 3.2 Review

## Three things that could be better
1. The resume command writes directly to terminal via IPC — could be fragile if terminal isn't ready
2. Pin state is local React state — will be persisted in Task 3.3
3. The ConversationCard doesn't show active/running status (green dot) — would need to cross-reference with activeProcesses

## One thing I'm fixing right now
The TerminalPane component uses `ref` but isn't wrapped in `forwardRef`. Since we only use the ref for the terminalWrite IPC, I'll remove the ref prop from ProjectView — we use `window.electronAPI.terminalWrite` directly.

## Concerns
- Double-click to open preview may not feel intuitive — could add an explicit preview button
- The sidebar width of w-70 (280px) is fixed — should resize on smaller screens

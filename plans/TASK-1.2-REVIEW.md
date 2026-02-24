# Task 1.2 — Review

## Three things that could be better
1. Could debounce the unregister call, but PTY exits are infrequent so unnecessary
2. The empty dependency array means this effect runs once on mount — correct for a global listener
3. Could log when an agent is unregistered for debugging, but that would add console noise

## One thing I'm fixing now
Nothing — the implementation is clean and minimal.

## Concerns
- The onTerminalExit listener in ProjectView fires for ALL terminals (not just agent tabs). The unregisterAgentsByTabId call is a no-op for tabs that have no agent registered, so this is safe.

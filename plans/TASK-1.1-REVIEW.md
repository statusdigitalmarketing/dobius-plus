# Task 1.1 — Review

## Three things that could be better
1. The runningAgents cleanup logic is duplicated across removeTab, closeOtherTabs, closeTabsToRight — could extract a helper, but keeping it inline matches existing patterns and avoids premature abstraction
2. The `for...of Object.keys` pattern could use Object.entries for marginally cleaner code, but it works correctly as-is
3. Could add a `getRunningAgentTabId(agentId)` selector, but consumers can derive it from runningAgents directly

## One thing I'm fixing now
Nothing — the implementation is clean and follows existing store patterns exactly.

## Concerns
- None. The cleanup paths are comprehensive: removeTab (single), closeOtherTabs (bulk), closeTabsToRight (bulk), plus the explicit unregisterAgentsByTabId for PTY exit events.

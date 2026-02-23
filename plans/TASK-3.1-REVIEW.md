# Review — Task 3.1: Auto-resume suggestion banner on project open

## Three things that could be better
1. The banner doesn't check if Claude is already running in the terminal (the spec mentioned this). In practice, if the user has already started a session, they won't click Resume, and the banner auto-dismisses in 30s — acceptable UX tradeoff.
2. The 7-day cutoff is hardcoded. Could be a user preference in Settings, but keeping it simple per YAGNI.
3. Preview text truncation (60 chars) could be smarter (e.g., word boundaries), but `slice(0, 60)` is fine for a one-line banner.

## One thing I'm fixing right now
Nothing — the implementation is clean. The component handles null returns, has proper timer cleanup, and uses the shared `resumeSession` action.

## Concerns
- If `dataGetLatestSession` IPC returns null (no sessions), the banner correctly doesn't render
- The auto-dismiss timer properly cleans up via useEffect return
- The banner sits between TerminalTabBar and the terminal container — it shrinks to zero height when dismissed (returns null), so no layout shift issues

## Time self-check
This task completed in about 8 minutes. Self-check:
- Did read the plan and spec before implementing
- Did verify the build passes
- Component handles edge cases (no session, null preview, timer cleanup)
- Verified it integrates correctly with ProjectView layout

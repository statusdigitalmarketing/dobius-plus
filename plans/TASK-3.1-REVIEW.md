# Task 3.1 Review — Build completion notifications

## Three things that could be better
1. The notification body shows "N/N tasks completed" which is redundant when all tasks are done — could say "All N tasks completed successfully" instead.
2. The notifiedRef tracks by build_start + projectDir — if someone restarts a build with same start timestamp (unlikely but possible), it won't re-notify.
3. The buildComplete state is synced from hook → local state → Zustand store, which is a 3-step chain — could simplify by having the hook write directly to the store.

## One thing I'm fixing right now
Nothing — the notification flow is clean: hook detects completion → fires IPC notification → sets badge state.

## Concerns
- Electron's Notification API requires the app to be built/packaged to show the app icon — in dev mode, notifications will use a generic icon.
- The badge dot persists until the user switches to the Builds tab (then buildComplete resets to false when build changes) — this is the desired UX.

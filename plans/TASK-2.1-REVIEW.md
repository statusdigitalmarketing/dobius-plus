# Task 2.1 Review — Build Monitor Data Service + IPC

## Three things that could be better
1. detectActiveBuilds uses pgrep which may not find builds running in Docker/remote — acceptable for local monitoring.
2. loadBuildProgress doesn't validate the JSON schema — just parses whatever is there. Could add schema validation.
3. The pickDirectory IPC handler doesn't persist the selected directory — Task 2.5 will store it in config.

## One thing I'm fixing right now
Nothing — clean implementation following existing data-service.js patterns exactly.

## Concerns
- pgrep regex "claude.*dangerously-skip-permissions" may also match the pgrep process itself — pgrep usually excludes itself, but worth noting.
- loadSupervisorLog reads the entire file then slices last 50 lines — for very large logs, could use readline, but 50 lines is trivial.

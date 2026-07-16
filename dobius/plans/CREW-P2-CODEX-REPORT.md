# Crew Phase 2 Codex Report

## SDK fields verified

- `Options.outputFormat?: { type: 'json_schema', schema: ... }` exists in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- Success result messages expose `structured_output?: unknown`.
- Error result subtype includes `error_max_structured_output_retries`.
- `PermissionMode` includes `dontAsk`, so heartbeat runs use `permissionMode: 'dontAsk'`.
- `Options.maxTurns` and `Options.maxBudgetUsd` both exist. Heartbeat runs pass both.

## Dueness logic

- A single heartbeat service starts with the agents IPC registration and ticks every 60 seconds.
- Disabled agents, paused crew state, quiet hours, and agents with a live run are skipped.
- `every10min`: due when the last persisted heartbeat is at least 10 minutes old.
- `hourly`: due at local minute `0`, once per local hour.
- `daily`: due once per local day after the agent's `at` time.
- `weekdays`: same as daily, but skipped on local Saturday/Sunday.
- Quiet hours compare local minutes of day and support windows that cross midnight.
- `lastHeartbeatAt` is persisted on the agent record before launch to prevent duplicate starts on adjacent ticks.

## Budget and demotion logic

- Ping config is persisted in `agents-config.json` with `maxPingsPerDay` default `4`.
- Ping counters reset on the local calendar day.
- `silent` verdicts are only reflected in run history/progress logs.
- `digest` verdicts append to `agents-briefing.json`; they notify only when the agent's notify setting is `everything`, and that notification consumes ping budget.
- `now` verdicts consume ping budget before notifying. If the budget is exhausted, the item is appended as digest with `demoted: true`.
- Briefing items are capped at 200 and the renderer lists items from the last 48 hours.

## Files changed

- Shared types: `src/shared/agents.ts`.
- Main agent data/runtime: `src/main/agents/agents-store.ts`, `agent-record-normalization.ts`, `agent-runner.ts`, `agent-run-prompt.ts`, `agent-runs-store.ts`, `agent-identity-files.ts`.
- Phase 2 stores/services: `src/main/agents/agent-heartbeat-service.ts`, `agent-briefing-store.ts`, `agents-config-store.ts`.
- IPC/preload: `src/main/ipc/agents.ts`, `src/preload/api-types.ts`, `src/preload/index.ts`.
- Renderer: agents page/header/detail components, schedule editor, briefing card/tune modal, run history tag.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.
- Both commands emitted the existing Node engine warning: repo wants Node 24; this shell is Node v26.0.0.
- Build also emitted existing Vite dynamic/static import chunking warnings.

## Uncertainties

- The silent-run count in the briefing footer is derived cheaply from heartbeat run history and briefing items; it is intentionally approximate because silent verdicts do not create briefing records.

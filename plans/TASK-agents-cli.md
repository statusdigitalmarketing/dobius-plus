# TASK: Expose Agents (Agents tab) through runtime RPC + dobius CLI

## What
The Agents tab (CustomAgent, Claude Agent SDK runner) is IPC-only — CLI sessions
can't see or create agents, so they fall back to `automations create`. Mirror the
automations wiring:

- `src/main/runtime/rpc/methods/agents.ts` — agent.list/show/create/update/delete/run/runs (direct import of agents-store + agent-runner, same pattern as methods/skills.ts)
- `src/main/agents/agent-runner.ts` — default `prepareClaudeLaunch` setter so RPC `agent.run` can start runs; set from `ipc/agents.ts` at boot
- `src/cli/specs/agents.ts`, `src/cli/handlers/agents.ts`, `src/cli/custom-agent-format.ts` — CLI command family
- Register in `methods/index.ts`, `specs/index.ts`, `dispatch.ts`, re-export formatters in `format.ts`, help section in `help.ts` with an explicit Agents-vs-Automations distinction line

## Why
Root cause of the "asked for an agent, got an automation" bug: the CLI offers no
agents surface at all.

## Test
`npm run typecheck`/`npm run build` exit 0; `vitest` for cli/index.test.ts (help)
passes; manual: `dobius agents list` against running app.

## Risks
- `agent.run` on a headless runtime without the Electron app: guard with a clear error when no launch preparer is registered.
- Heartbeat/notify/channels/icon/color intentionally NOT exposed via CLI flags (UI-only); defaults apply.

## Estimate
~350 lines across 9 files.

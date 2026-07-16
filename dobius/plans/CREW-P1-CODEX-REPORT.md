# Crew Phase 1 Codex Report

## Files created

- `src/main/agents/agent-identity-files.ts`
- `src/renderer/src/components/agents/AgentAvatar.tsx`
- `src/renderer/src/components/agents/AgentMemoryView.tsx`
- `src/renderer/src/components/agents/CrewFilesDialog.tsx`

## Files changed

- `src/shared/agents.ts`
- `src/main/agents/agents-store.ts`
- `src/main/agents/agent-runner.ts`
- `src/main/ipc/agents.ts`
- `src/preload/api-types.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/agents/AgentEditForm.tsx`
- `src/renderer/src/components/agents/AgentList.tsx`
- `src/renderer/src/components/agents/AgentsPage.tsx`
- `src/renderer/src/components/agents/agent-page-state.ts`

## SDK session fields used

- Capture from `SDKSystemMessage` when `type === 'system'` and `subtype === 'init'`: `message.session_id`.
- Capture from `SDKResultMessage` when `type === 'result'`: `message.session_id`.
- Resume input on `Options`: `resume: agent.lastSessionId`.
- Resume is only set when `agent.lastSessionId` exists and `agent.lastSessionCwd === resolvedCwd`.
- Runs always pass `cwd: resolvedCwd`, where `~` is expanded to the user home directory before starting the SDK query.

## systemPrompt composition order

The runner composes non-empty markdown sections in this order:

1. `soul.md` as `## Soul`
2. `role.md` as `## Role`
3. `playbook.md` as `## Playbook`
4. `rules.md` as `## Rules`
5. `_crew/USER.md` as `## About the user`
6. `_crew/TOOLS.md` as `## House tool conventions`
7. `memory.md` as `## Memory`
8. Last 40 non-empty lines from `progress-log.md` as `## Progress log (recent)`

If all files are empty, `agent.systemPrompt` is used as the backward-compatible fallback.

## Migration behavior

- Existing `agents.json` records missing `icon` load with `bot`.
- Existing `agents.json` records missing `color` load with `#b9bcc2`.
- Invalid stored icon/color values are sanitized to the same defaults.
- Missing `lastSessionId` and `lastSessionCwd` are accepted.
- Deleting an agent only removes its `agents.json` record; `~/.dobius/agents/<agentId>/` is left on disk.

## Verification

- `pnpm exec oxfmt --write <touched files>`: passed.
- `pnpm run typecheck`: passed with the existing Node engine warning (`wanted node 24`, current `v26.0.0`).
- `pnpm run build:electron-vite`: passed with existing Vite dynamic-import warnings.
- Targeted vitest: not run because no direct test files exist for the files changed in this Phase 1 slice.

## Uncertain

- The Memory tab subtitle estimates session age from the agent record `updatedAt`; there is no dedicated `lastSessionAt` field in Phase 1.
- Resume retry handling starts a fresh session if the initial resumed stream fails before the SDK init message. If the SDK reports a different fresh `session_id`, the new ID is persisted and the run continues.

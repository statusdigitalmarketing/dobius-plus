# Agents Feature Report

## Files Created

- `src/shared/agents.ts`
- `src/main/agents/agents-store.ts`
- `src/main/agents/agent-runs-store.ts`
- `src/main/agents/agent-runner.ts`
- `src/main/ipc/agents.ts`
- `src/renderer/src/components/agents/AgentsPage.tsx`
- `src/renderer/src/components/agents/AgentList.tsx`
- `src/renderer/src/components/agents/AgentEditForm.tsx`
- `src/renderer/src/components/agents/AgentRunView.tsx`
- `src/renderer/src/components/agents/agent-page-state.ts`

## Files Changed

- `src/main/ipc/register-core-handlers.ts`
- `src/preload/index.ts`
- `src/preload/api-types.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/store/slices/ui.ts`
- `src/renderer/src/hooks/resolve-zoom-target.ts`
- `src/renderer/src/components/DobiusTitlebarButtons.tsx`
- `src/renderer/src/components/right-sidebar/index.tsx`

## SDKMessage Variants Handled

- `assistant`: emits assistant text blocks as `assistant-text`, tool-use blocks as `tool-use`, and assistant errors as `error`.
- `user`: emits `tool_result` content blocks as `tool-result`.
- `result`: emits success as `result`, error result subtypes as `error`, and stores `result` / `errors`, `num_turns`, and `total_cost_usd`.
- `system` `init`: emits a `system` event with model/cwd detail.
- `system` `permission_denied`: emits an `error` event.
- `tool_progress`: emits compact `tool-use` progress.
- `tool_use_summary`: emits `tool-result` summary.
- Unknown SDK variants are ignored by the default case.

## Auth Environment

The runner calls the existing Claude launch preparation resolver registered through core IPC. It clones `process.env`, applies `applyClaudeEnvPatch(baseEnv, preparation.envPatch, { stripAuthEnv: preparation.stripAuthEnv })`, and passes that result as SDK `options.env`. It does not read or set `ANTHROPIC_API_KEY`.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.
- Targeted tests: no targeted test file existed for the newly added Agents files or the touched zoom/titlebar/page wiring.

Both commands printed the existing Node engine warning because this shell is on Node v26 while the package requests Node 24. The build also printed existing Vite dynamic/static import chunk warnings.

## Notes

- Empty agent cwd runs from the main-process `os.homedir()` default. The renderer placeholder is `~` because there was no existing preload API for the concrete host home path.
- `bypassPermissions` sets both `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`, as required by the SDK declarations.
- Run history is capped at 50 entries and persisted to `agents-runs.json`; persisted `running` entries are marked error with summary `app restarted during run` on load.

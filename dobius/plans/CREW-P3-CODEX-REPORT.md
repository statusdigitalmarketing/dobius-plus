# Crew Phase 3 Codex Report

## SDK Shapes Verified

Source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` v0.3.201.

- `Options.canUseTool?: CanUseTool`
- `CanUseTool = (toolName: string, input: Record<string, unknown>, options) => Promise<PermissionResult | null>`
- `canUseTool` options used:
  - `signal: AbortSignal`
  - `suggestions?: PermissionUpdate[]`
  - `decisionReason?: string`
  - `title?: string`
  - `displayName?: string`
  - `description?: string`
  - `toolUseID: string`
  - `requestId: string`
- `PermissionResult` used:
  - allow: `{ behavior: 'allow', updatedInput?, updatedPermissions? }`
  - deny: `{ behavior: 'deny', message, interrupt? }`
- `PermissionUpdate` for always-allow:
  - The queue returns the SDK-provided `options.suggestions` directly as `updatedPermissions`.
  - If no suggestions are supplied, it returns plain allow and the IPC result includes a note.
- `Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`
- `HookEvent` used: `'PreToolUse'`
- `HookCallbackMatcher` used: `{ hooks: [async hook] }`
- PreToolUse hook output used:
  - `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' | 'allow' | 'ask', permissionDecisionReason } }`
  - This implementation emits `permissionDecision: 'deny'` for hard rails and `{ continue: true }` otherwise.
- `Query.setPermissionMode(mode: PermissionMode): Promise<void>`
  - `bypassRun` calls `setPermissionMode('bypassPermissions')` before resolving the pending tool call as allow.

## Decision Lifecycle

1. Manual, non-bypass runs get `Options.canUseTool = createAgentCanUseTool(...)`.
2. Auto-approved tools do not enter the queue because the SDK handles `allowedTools` before `canUseTool`.
3. `canUseTool` creates a `PendingAgentDecision` with run/agent/tool/input, SDK title/displayName/description, cwd, branch, and timestamp.
4. The promise stays pending in `agent-decision-queue.ts` until IPC `agents:resolveDecision`.
5. Resolution actions:
   - `approve`: allow original input.
   - `approveEdited`: allow edited input, merging Bash command strings into `input.command`.
   - `alwaysAllow`: allow original input plus SDK `suggestions` as `updatedPermissions` when present.
   - `deny`: deny with `Denied by user`.
   - `respond`: deny with the user response text.
   - `bypassRun`: set live `Query` mode to `bypassPermissions`, then allow this call.
6. Run stop and run completion call `denyPendingDecisionsForRun(...)`, resolving any leftovers as deny with `interrupt: true`.

## Hard-Rail Matchers

Implemented in `src/main/agents/agent-hard-rails.ts` and attached to every run, including heartbeat and bypass runs.

- Bash denies:
  - `git push --force`, `git push --force-with-lease`, and `git push -f`-style flags.
  - `rm -rf /` and `rm -rf /*`-style root deletes.
- Credential targets deny:
  - `~/.claude/.credentials.json`
  - `~/.claude/credentials*`
  - `~/.dobius/**/token*`
  - `~/Library/Keychains`
  - `.env` and `.env.*`
- Agent identity isolation denies:
  - `Write`, `Edit`, and `MultiEdit` into another agent directory under `~/.dobius/agents/`.

## Files Created/Changed

Created:
- `src/main/agents/agent-hard-rails.ts`
- `src/main/agents/agent-decision-queue.ts`
- `src/main/agents/agent-notification-store.ts`
- `src/main/agents/agent-run-progress-log.ts`
- `src/main/agents/agent-runner-environment.ts`
- `src/renderer/src/components/agents/AgentDecisionTicketDialog.tsx`
- `src/renderer/src/components/agents/AgentDecisionStrip.tsx`
- `src/renderer/src/components/agents/use-agent-decisions.ts`
- `src/renderer/src/components/agents/use-agent-page-initial-load.ts`
- `src/renderer/src/components/agents/agent-briefing-count.ts`
- `src/renderer/src/components/agents/agent-default-files.ts`

Changed:
- `src/shared/agents.ts`
- `src/main/agents/agent-runner.ts`
- `src/main/agents/agent-heartbeat-service.ts`
- `src/main/ipc/agents.ts`
- `src/preload/api-types.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/DobiusTitlebarButtons.tsx`
- `src/renderer/src/components/agents/AgentsPage.tsx`
- `src/renderer/src/components/agents/AgentList.tsx`
- `src/renderer/src/components/agents/AgentRunView.tsx`

## Verification

- `pnpm exec oxlint <changed files>`: passed.
- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.

Notes:
- Commands emitted the existing Node engine warning because this environment is Node v26 while `package.json` wants Node 24.
- `build:electron-vite` emitted existing Vite dynamic/static import warnings.

## Uncertainties

- The UI was verified by typecheck/build, not an interactive Playwright run.
- The SDK stores always-allow permissions from returned `updatedPermissions`; this implementation intentionally relies on SDK-provided `suggestions` instead of constructing host-specific rules.

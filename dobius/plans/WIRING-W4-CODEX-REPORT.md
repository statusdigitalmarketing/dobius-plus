# W4 Wiring Report

## Summary

W4 wires `dispatch_build` live through a tiny module-level registry. The tool now resolves a repo by exact id or case-insensitive display name, creates a managed worktree with the configured build agent, injects the agent-provided brief as `startupPrompt`, files a human-visible briefing item, and returns the created worktree id.

## CreateWorktreeResult Id

The dispatcher returns `result.worktree.id` from `CreateWorktreeResult`.

`AutomationWorkspaceProvenance` is optional on `DobiusRuntimeService.createManagedWorktree`, so W4 omits it rather than inventing automation-run metadata.

## Registry Wiring

Added `src/main/agents/agent-dispatch-registry.ts` with two nullable module-level slots:

- `BuildDispatcher`
- `RepoLister`

`registerCoreHandlers` sets both at boot from the existing runtime:

- `setRepoLister(() => runtime.listRepos().map(repo => ({ id: repo.id, name: repo.displayName || repo.id })))`
- `setBuildDispatcher(...)` calls only `runtime.createManagedWorktree(...)`

The setters run before the one-time IPC registration guard so reopened windows refresh runtime-backed closures without restructuring `register-core-handlers`.

## dispatch_build Behavior

Inputs:

- `repo`
- `brief`
- `branchName?`

Behavior:

- Resolves repo by exact id first, then case-insensitive display name.
- Unknown repos return an `isError` tool result with available repo names.
- Uses `autoMode.buildAgent`, defaulting to `claude`.
- Uses `branchName.trim()` when provided, otherwise a six-word lowercase slug sanitized to `[a-z0-9-]`.
- Caps the startup brief to 6000 characters.
- On success, files a `now` briefing: `Build dispatched: <repo> / <name>`.

## Non-Destructive Proof

The dispatch path is non-destructive:

- `dispatch_build` imports the registry and briefing/config stores only.
- The registered dispatcher calls `runtime.createManagedWorktree` with `activate: false`, `startupAgent`, `startupPrompt`, and `createdWithAgent`.
- A source scan of the dispatch files found no `markTaskComplete`, `postTaskComment`, `asanaPost`, merge, or source-control push path. The only `push` matches were ordinary array pushes in existing knowledge-response code and the MCP description text saying the tool never pushes.

Asana comments remain draft-only through `asana_draft_comment`; W4 does not auto-post or auto-complete tasks.

## Triage Split

The Asana auto-mode prompt now makes the lane split explicit:

- BUILD lane: actionable tasks may call `dispatch_build`, file a briefing item, and draft the ack comment: `On it. <one line>. Will post an update when done.`
- REVIEW lane: do not dispatch build work; draft review notes or a clarifying question.
- Vague or blocked tasks: do not dispatch; draft a concise clarifying question.

The prompt reiterates that the triage agent must not post directly to Asana, push, merge, or mark complete.

## Config And UI

Added `autoMode.buildAgent?: TuiAgent` with default `claude`. `asana-config` sanitizes invalid values back to `claude`.

`AsanaPane` now shows a build-agent picker next to the triage-agent picker. It uses existing enabled TUI agent data from settings and existing catalog labels.

## Files Changed

- `src/main/agents/agent-dispatch-registry.ts`
- `src/main/agents/agent-tools/dobius-tool-handlers.ts`
- `src/main/agents/agent-tools/dobius-tool-server.ts`
- `src/main/agents/agent-tools/dobius-tool-server.test.ts`
- `src/main/agents/asana-auto-mode-service.ts`
- `src/main/asana/asana-config.ts`
- `src/main/asana/asana-config.test.ts`
- `src/main/ipc/register-core-handlers.ts`
- `src/main/ipc/register-core-handlers.test.ts`
- `src/renderer/src/components/settings/AsanaPane.tsx`
- `src/shared/asana.ts`
- `plans/WIRING-W4-CODEX-REPORT.md`

No `knowledge/*` files were changed.

## Verification

Passed:

- `pnpm exec oxlint src/main/agents/agent-dispatch-registry.ts src/main/agents/agent-tools/dobius-tool-handlers.ts src/main/agents/agent-tools/dobius-tool-server.ts src/main/agents/agent-tools/dobius-tool-server.test.ts src/main/agents/asana-auto-mode-service.ts src/main/asana/asana-config.ts src/main/asana/asana-config.test.ts src/main/ipc/register-core-handlers.ts src/main/ipc/register-core-handlers.test.ts src/renderer/src/components/settings/AsanaPane.tsx src/shared/asana.ts`
- `pnpm exec vitest run --config config/vitest.config.ts src/main/agents/agent-tools/dobius-tool-server.test.ts src/main/asana/asana-config.test.ts src/main/agents/asana-dispatch-ledger.test.ts src/main/agents/asana-triage-verdict.test.ts src/main/agents/asana-untrusted-text.test.ts src/main/ipc/register-core-handlers.test.ts`
- `pnpm run typecheck`
- `pnpm run build:electron-vite`

Note: `pnpm test -- <files>` unexpectedly launched the broader suite in this repo and was interrupted after unrelated failures. The intended focused files were rerun directly with `pnpm exec vitest run ...` and passed.

Environment warning observed on pnpm commands: package requests Node 24, current runtime was Node v26.0.0.

## Deferred To W5

- Fully autonomous verify pipeline.
- Auto-detecting build agent completion.
- Running review-audit/ship-test and bounded self-repair.
- Automatic receipt assembly into the draft Asana completion/update comment.

W4 leaves the human driving build/verify after dispatch and ack-draft.

## Uncertainties

The design note described repo names as `repo.name`, but the actual `Repo` type exposes `displayName`. The registry maps `displayName || id` as the human-facing repo name.

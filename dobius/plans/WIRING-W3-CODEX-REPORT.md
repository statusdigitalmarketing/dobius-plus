# W3 Wiring Report

## Edge Detection And Claim Proof

- The poller lives in `src/main/agents/asana-auto-mode-service.ts` and starts from `registerAgentsHandlers()` next to heartbeats.
- Each due poll calls `refreshAsanaTasks()` and iterates only `build` and `review` lanes from the Asana snapshot.
- For each task, the poller skips completed tasks, `hasBeenClaimed(gid)`, and `isDead(gid)` before dispatch.
- `claimTask(gid, lane)` writes `asana-dispatch-ledger.json` before any triage run starts. A second claim for a claimed, briefed, or dead gid returns `null`.
- Because the claim is persisted before dispatch, a task that remains present across 10-minute polls cannot dispatch twice. A failed record is the only retryable state; it can be reclaimed once, then the second failure dead-letters it.

## Sanitizer Coverage

- `src/main/agents/asana-untrusted-text.ts` strips HTML comments/tags, zero-width/invisible characters, soft hyphen, bidi controls, collapses excessive blank lines, trims, and caps at 8000 characters with a truncation note.
- `wrapUntrustedTaskText()` sanitizes title and notes, then wraps them in an explicit untrusted-data block.
- Tests cover script tag stripping, invisible character stripping, blank-line collapse, length cap, delimiter wrapping, and preserving an injection string as inert text inside the block.

## Poison And Dead-Letter Flow

- Asana task title/notes are passed to the triage prompt only through `wrapUntrustedTaskText()`.
- The triage prompt states that the lane is deterministic and that task text is third-party untrusted data, not instructions.
- `recordFailure(gid)` increments attempts. Attempt 1 moves the record to `failed`; attempt 2 moves it to `dead`.
- When a task becomes `dead`, the poller appends a `run-failed` notification and a `now` briefing item: `Asana task <gid> dead-lettered after 2 failed triage attempts`.

## Triage Run Options

Exact options passed to `startAgentRun()` for triage:

```ts
{
  source: 'asana',
  permissionMode: 'dontAsk',
  allowedTools: ['mcp__dobius__*'],
  maxTurns: 15,
  maxBudgetUsd: 0.3,
  outputFormat: triageOutputFormat(),
  onResult,
  onRunEnded
}
```

This preserves the minimal tool surface: only dobius MCP tools are requested, and the existing runner still attaches the dobius MCP server, strict MCP config, and hard rails.

## Wiring Point

- `src/main/ipc/agents.ts` now calls `startAsanaAutoMode(prepareClaudeLaunch)` immediately after `startAgentHeartbeats(prepareClaudeLaunch)`.
- `src/shared/agents.ts` adds `source: 'asana'` and the shared `TriageVerdict` type.
- `src/shared/asana.ts` adds `autoMode.triageAgentId?: string`.

## Files

- Added `src/main/agents/asana-auto-mode-service.ts`
- Added `src/main/agents/asana-dispatch-ledger.ts`
- Added `src/main/agents/asana-dispatch-ledger.test.ts`
- Added `src/main/agents/asana-triage-verdict.ts`
- Added `src/main/agents/asana-triage-verdict.test.ts`
- Added `src/main/agents/asana-untrusted-text.ts`
- Added `src/main/agents/asana-untrusted-text.test.ts`
- Updated Asana config, shared types, agent run source sanitization, Asana settings UI/search copy, and agents IPC startup.

## Verification

- `pnpm exec vitest run src/main/agents/asana-untrusted-text.test.ts src/main/agents/asana-dispatch-ledger.test.ts src/main/agents/asana-triage-verdict.test.ts src/main/asana/asana-config.test.ts` passed: 4 files, 14 tests.
- `pnpm exec oxlint <changed files>` passed.
- `pnpm run build:electron-vite` passed.
- `pnpm run typecheck` did not pass because of an unrelated existing renderer knowledge navigation type mismatch:
  `src/renderer/src/hooks/useIpcEvents.ts(2747,11): Type '"knowledge"' is not assignable ...`.
  This W3 change did not modify `knowledge/*` files.

## Uncertainties

- The no-triage-agent fallback claims and marks the task briefed after filing a briefing item, so the task will not re-fire. That matches the idempotency rule, but it means setting a triage agent later will not retroactively triage already surfaced tasks.
- The current W3 implementation uses the dispatch ledger as the claim lock. It does not write an explicit Asana ack draft at claim time; triage may draft a clarification question through `asana_draft_comment`, and all Asana posting remains human-approved only.

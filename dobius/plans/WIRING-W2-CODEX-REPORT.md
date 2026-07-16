# W2 Wiring Report

## Single Write Path Proof

- `postTaskComment` is exported only from `src/main/asana/asana-client.ts`.
- The only production caller of `postTaskComment` is `src/main/agents/agent-draft-approval.ts`.
- The only production caller of `approveDraftAndPost` is the `agents:approveDraft` IPC handler in `src/main/ipc/agents.ts`.
- Renderer access goes through `window.api.agents.approveDraft(id)`, which is called by the Agents page draft approval button after the confirmation dialog.
- No `agent-tools/*` module references `postTaskComment` or `approveDraftAndPost`.

`agent-draft-store.ts` remains network-free. POST failures rethrow and do not call `setDraftStatus`, so drafts stay pending for retry.

## Notes Field Wiring

- `TASK_FIELDS` now includes `notes`.
- The Asana task response row type includes `notes?: string | null`.
- `fetchLane` maps absent notes to `''`.
- The shared `AsanaTask` type now includes `notes: string`.

## Files

- `src/main/asana/asana-client.ts`
- `src/main/asana/asana-client.test.ts`
- `src/main/agents/agent-draft-approval.ts`
- `src/main/agents/agent-draft-approval.test.ts`
- `src/main/agents/agent-draft-store.ts`
- `src/main/ipc/agents.ts`
- `src/preload/index.ts`
- `src/preload/api-types.ts`
- `src/shared/asana.ts`
- `src/renderer/src/components/agents/AgentDraftsPanel.tsx`
- `src/renderer/src/components/agents/AgentMissionControlPanel.tsx`
- `src/renderer/src/components/agents/AgentsPage.tsx`
- `src/renderer/src/components/agents/use-agent-drafts.ts`
- `plans/WIRING-W2-CODEX-REPORT.md`

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/main/asana/asana-client.test.ts src/main/agents/agent-draft-approval.test.ts` passed.
- `pnpm exec oxlint <changed files>` passed.
- `pnpm run typecheck` passed. It emitted the existing Node engine warning: package wants Node 24, current runtime is Node v26.0.0.
- `pnpm run build:electron-vite` passed. It emitted existing Vite dynamic-import chunking warnings.
- Grep proof, excluding this report: `postTaskComment` appears only in `asana-client.ts`, `agent-draft-approval.ts`, and tests; `approveDraftAndPost` appears only in `agent-draft-approval.ts`, `ipc/agents.ts`, and tests.

# WIRING W1 Codex Report

## SDK Shapes Used

- `createSdkMcpServer({ name: 'dobius', version: '1.0.0', tools })` returns the SDK MCP server config with an in-process `instance`.
- `tool(name, description, inputSchema, handler)` is used with raw Zod shapes such as `{ gid: z.string(), body: z.string() }`, not `z.object(...)`.
- `Options.mcpServers` is wired as `{ dobius: buildDobiusRunMcpServer(agent.id, runId) }`.
- `Options.strictMcpConfig = true` is set so only the passed SDK MCP server loads.
- The runner appends the literal allow rule `mcp__dobius__*`; it does not use wider MCP globs.

## Tools

- `asana_draft_comment(gid, body)`: queues an `AgentDraftComment` with target `{ kind: 'asana', gid }`, attributed to the calling `agentId`, and files a digest briefing item. It imports no Asana module and makes no network call; tests also assert `fetch` is not called. Bodies over 4000 characters are truncated with a note.
- `read_knowledge(query, leafId?)`: calls `buildKnowledgeTree(store)`, checks every read with `isAllowedKnowledgePath(filePath, store)`, and reads content with `safeReadFile`. It returns an error tool result when knowledge is unavailable, missing, unreadable, or outside the allow gate.
- `list_crew()`: returns compact roster text with name, description/tagline, model, heartbeat enabled state, and iMessage state. It excludes cwd, tokens, and paths.
- `crew_status()`: returns running/idle and latest run status with a short redacted summary. It uses `listAgentRuns()` and `hasLiveAgentRun()` via a lazy import to avoid runner/tool initialization cycles.
- `file_briefing_item(urgency, summary)`: calls `appendBriefingItem({ agentId, urgency, summary })` and returns confirmation.

`dispatch_build` remains deferred to W4 and was not added.

## Draft Store and IPC

- Added `src/main/agents/agent-draft-store.ts`.
- Persists `agent-drafts.json` in `userData` with tmp-file then rename atomic writes.
- Caps stored drafts at 100.
- Exposes `appendDraft`, `listDrafts`, `getDraft`, and `setDraftStatus`.
- Broadcasts `agents:draftsChanged` on append/status changes.
- IPC added:
  - `agents:listDrafts`
  - `agents:discardDraft`
- Preload added:
  - `window.api.agents.listDrafts`
  - `window.api.agents.discardDraft`
  - `window.api.agents.onDraftsChanged`
- No approve-and-post Asana path exists in W1; a W2 TODO is left at the status transition point.

## Runner Wiring

- `startAgentRun` always attaches the Dobius SDK MCP server.
- Manual/default runs use `agent.allowedTools` plus `mcp__dobius__*`.
- Explicit allowed-tool runs, including channel read-only runs, preserve their existing list and append only `mcp__dobius__*`.
- Heartbeat runs inherit the runner’s allowedTools wiring, so `permissionMode: 'dontAsk'` can call the Dobius tools without widening built-in tool access.
- Existing hard-rail hooks remain attached unchanged.

## Renderer

- Added `AgentDraftsPanel` to the Agents page stack.
- Shows only pending drafts.
- Displays agent avatar, Asana gid, body preview, Discard, and disabled `Approve & post` with tooltip `Approve & post (W2)`.
- Subscribes to `agents:draftsChanged`.

## Files Changed

- `src/main/agents/agent-draft-store.ts`
- `src/main/agents/agent-draft-store.test.ts`
- `src/main/agents/agent-runner.ts`
- `src/main/agents/agent-runner-dobius-tools.ts`
- `src/main/agents/agent-tools/dobius-tool-handlers.ts`
- `src/main/agents/agent-tools/dobius-tool-server.ts`
- `src/main/agents/agent-tools/dobius-tool-server.test.ts`
- `src/main/ipc/agents.ts`
- `src/main/ipc/register-core-handlers.ts`
- `src/preload/api-types.ts`
- `src/preload/index.ts`
- `src/renderer/src/components/agents/AgentDraftsPanel.tsx`
- `src/renderer/src/components/agents/AgentMissionControlPanel.tsx`
- `src/renderer/src/components/agents/AgentsPage.tsx`
- `src/shared/agents.ts`

The concurrent-session knowledge files were not modified.

## Verification

- `pnpm exec oxlint <changed files>`: passed.
- `pnpm exec vitest run --config config/vitest.config.ts src/main/agents/agent-draft-store.test.ts src/main/agents/agent-tools/dobius-tool-server.test.ts`: passed, 8 tests.
- `pnpm run typecheck`: passed. The command emitted only the local Node engine warning (`wanted node 24`, current `v26.0.0`); no knowledge errors appeared.
- `pnpm run build:electron-vite`: passed. Vite emitted existing-style dynamic/static import chunking warnings.

## Uncertainties

- `read_knowledge` search is intentionally simple case-insensitive title/summary matching for W1.
- `crew_status` redacts obvious token/secret/password/api-key patterns in summaries, but it is not a full secret scanner.

# Crew Phase 4 Codex Report

## Routing Rules

- The existing iMessage bridge remains the only `chat.db` poller.
- Each inbound self-thread message is checked for an agent mention before terminal dispatch.
- `@AgentName <ask>` routes to the longest enabled agent-name prefix, case-insensitively.
- Agent names with spaces also match compact aliases, such as `@sentrywatch` for `Sentry Watch`.
- Non-`@` messages return `not-handled` and continue to the existing terminal-prefix path.
- Unknown `@` mentions reply with reachable agent names, or with the no-reachable-agents message.
- Empty asks are converted to `Report your current status briefly.`

## Guard Set

- Channel runs use only the intersection of the agent tools and `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`.
- Channel runs pass the restricted tool list to both `allowedTools` and SDK `tools`.
- Channel runs use `permissionMode: 'dontAsk'`.
- Channel runs cap at `maxTurns: 25` and `maxBudgetUsd: 0.5`.
- Channel runs do not resume prior sessions.
- Existing agent hard rails are still attached by `startAgentRun`.
- The prompt marks the text as untrusted phone-originated data and asks for 2-4 sentence plain-text replies.

## Reply Formats

- Success: `${agent.name}: ${resultText}`
- Success replies are truncated to 1400 characters, with `…` appended when truncated.
- SDK error result: `${agent.name}: run failed (<subtype>)`
- Start failure: `${agent.name} is busy — try again in a minute.`
- Unknown mention with reachable agents: `Reachable via iMessage: <names>`
- Unknown mention with no reachable agents: `No agents are reachable via iMessage — enable it per agent in Dobius+.`

## Bridge Wiring Point

- `src/main/imessage-bridge/bridge-service.ts` now calls `handleChannelMessage` inside `pollNewMessages`, immediately after text extraction and before `matchTriggeredCommand`.
- Only `not-handled` channel results fall through to the existing terminal dispatch.
- `startImessageBridge` accepts an optional Claude launch preparation callback.
- `src/main/index.ts` passes the same Claude auth preparation chain used by Agents IPC.
- Replies use the existing `sendImessage(selfHandle, reply)` path.

## Files

- `src/shared/agents.ts`
- `src/main/agents/agent-record-normalization.ts`
- `src/main/agents/agents-store.ts`
- `src/main/agents/agent-runs-store.ts`
- `src/main/agents/agent-runner.ts`
- `src/main/agents/agent-channel-service.ts`
- `src/main/agents/agent-channel-service.test.ts`
- `src/main/imessage-bridge/bridge-service.ts`
- `src/main/index.ts`
- `src/renderer/src/components/agents/AgentEditForm.tsx`
- `src/renderer/src/components/agents/AgentRunView.tsx`
- `src/renderer/src/components/agents/AgentDetailHeader.tsx`
- `src/renderer/src/components/agents/agent-page-state.ts`

## Verification

- `npx vitest run --config config/vitest.config.ts src/main/agents/agent-channel-service.test.ts` passed.
- `pnpm exec oxlint <changed files>` passed.
- `pnpm run build:electron-vite` passed.
- `pnpm run typecheck` did not complete because the dirty pre-existing file `src/main/ipc/knowledge.ts` has `TS6133: 'dirname' is declared but its value is never read.`

## Uncertainties

- I did not modify the unrelated dirty knowledge/preload files already present in the worktree.
- The iMessage bridge could not be live-tested against macOS Messages in this environment.

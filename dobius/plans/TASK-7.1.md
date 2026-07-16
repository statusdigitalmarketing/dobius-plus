# TASK 7.1 — Agents page (custom agentic agents via Claude Agent SDK)

## What
A working, functional Agents surface in Dobius+: define custom agents (name, description, system prompt, model, allowed tools, working dir), run them headless in the main process via `@anthropic-ai/claude-agent-sdk` (v0.3.201, already installed), stream live output into a dedicated full-page Agents view, keep run history. Opened via a new titlebar button next to Tasks.

## Why
Interactive agents already exist (PTY terminals). This adds programmatic/autonomous agents — the building block for Asana-lane automation, monitors, and scheduled jobs — without a terminal.

## How (architecture, anchored to existing patterns)
- **Storage**: `src/main/agents/agents-store.ts` — self-owned `agents.json` in userData, atomic write, mirroring `src/main/prompts/prompts-store.ts`.
- **Runner**: `src/main/agents/agent-runner.ts` — SDK `query()`, auth rides the app-managed Claude login via `applyClaudeEnvPatch` (`src/main/claude-accounts/environment.ts`), events broadcast to renderer, stop via `interrupt()`/AbortController, run summaries in `agents-runs.json` (cap 50), max 3 concurrent runs.
- **IPC**: `src/main/ipc/agents.ts` registered in `register-core-handlers.ts`; preload `window.api.agents` mirroring the asana block (`src/preload/index.ts:1013-1033`).
- **UI**: new `activeView: 'agents'` (`store/slices/ui.ts:548`), lazy `AgentsPage` in `App.tsx:2334-2355` switch; titlebar button in `DobiusTitlebarButtons.tsx`. Rename the existing vault sidebar tab label "Agents" → "Sessions" (collision).

## Test
`pnpm typecheck` + `pnpm run build:electron-vite` exit 0; install; create an agent (Read/Grep/Glob tools, cwd = a repo), run a prompt, watch streamed output, confirm result + history entry survives relaunch; stop button cancels a run.

## Risks
- SDK spawns the bundled Claude Code executable — must inherit the managed `CLAUDE_CONFIG_DIR`, not ambient env (else wrong account / no auth).
- Permission model: headless runs use `permissionMode: 'default'` — tools listed in `allowedTools` are permitted, everything else denied (no hangs). `bypassPermissions` is an explicit per-agent opt-in toggle.
- Streaming volume: renderer must cap transcript length (keep last ~500 events).

## Estimate
1 codex stage (backend + UI), 1 review pass, build + install + live verify.

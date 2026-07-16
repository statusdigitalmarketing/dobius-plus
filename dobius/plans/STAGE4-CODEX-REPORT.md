# Stage 4 Codex Report

## 4a git-provider env vars

- Added `src/main/source-control/provider-env.ts` with `readProviderEnv(name)`.
- `readProviderEnv('GITEA_TOKEN')` checks `DOBIUS_GITEA_TOKEN` first and falls back to `DOBIUS_GITEA_TOKEN`; the same `DOBIUS_*` then `DOBIUS_*` behavior applies for all provider names passed to the helper.
- Updated Gitea, Azure DevOps, and Bitbucket auth/config reads to use `readProviderEnv(...)`.
- Updated user-visible provider env var names to `DOBIUS_*` in hosted-review auth instructions, blocked-review actions, settings integration cards, tests, and all locale JSON files.
- Ran `node config/scripts/verify-localization-catalog.mjs --fix`; locale catalog verification passed.
- Added `src/main/source-control/provider-env.test.ts` for `DOBIUS_*` precedence and legacy `DOBIUS_*` fallback.

## 4b agent-hook header and env vars

- Renamed hook HTTP header literals from `X-Dobius-Agent-Hook-Token` to `X-Dobius-Agent-Hook-Token`.
- Updated main and relay server readers to use Node's lowercased `x-dobius-agent-hook-token`.
- Renamed hook env keys across server env builders, endpoint file writer/parser/reader paths, PTY/relay/SSH/WSL pass-through allowlists, renderer/CLI launch env, hook script templates, JS/Python/PowerShell/POSIX hook implementations, E2E helpers, and related tests:
  - `DOBIUS_AGENT_HOOK_TOKEN`
  - `DOBIUS_AGENT_HOOK_PORT`
  - `DOBIUS_AGENT_HOOK_ENV`
  - `DOBIUS_AGENT_HOOK_VERSION`
  - `DOBIUS_AGENT_HOOK_ENDPOINT`
  - `DOBIUS_PANE_KEY`
  - `DOBIUS_TAB_ID`
  - `DOBIUS_AGENT_LAUNCH_TOKEN`
  - `DOBIUS_WORKTREE_ID`
  - `DOBIUS_HOOK_PROTOCOL_VERSION`
- Renamed the opencode hook pair to `DOBIUS_OPENCODE_HOOK_PORT` and `DOBIUS_OPENCODE_HOOK_TOKEN`.
- Left excluded internal names alone, including `DOBIUS_*_EVENT`, `DOBIUS_DEV_*`, `DOBIUS_RELAY_*`, `DOBIUS_SSH_*`, `DOBIUS_APP_*`, and MIME strings.

## Zero-leftover grep

Command:

```sh
git grep -n -e 'DOBIUS_AGENT_HOOK' -e 'X-Dobius-Agent-Hook' -e 'DOBIUS_PANE_KEY' -e 'DOBIUS_TAB_ID' -e 'DOBIUS_WORKTREE_ID' -e 'DOBIUS_AGENT_LAUNCH_TOKEN' -- .
```

Result: zero matches.

Also checked:

```sh
git grep -n -e 'DOBIUS_HOOK_PROTOCOL_VERSION' -e 'DOBIUS_OPENCODE_HOOK' -e 'x-dobius-agent-hook-token' -- .
```

Result: zero matches.

## Tests updated

- Updated hook/server/relay/PTY/renderer/CLI/E2E assertions to the `DOBIUS_*` env names and `X-Dobius-Agent-Hook-Token` header.
- Updated source-control UI tests to expect `DOBIUS_*` user-visible auth instructions.
- Added focused provider env helper tests for new-name precedence and old-name fallback.

## Verification

- `node config/scripts/verify-localization-catalog.mjs --fix`: passed.
- `pnpm run typecheck`: passed with 0 errors. Pnpm emitted an engine warning because the shell is using Node v26.0.0 while the project requests Node 24.
- `pnpm run build:electron-vite`: passed with exit 0. Build emitted existing Vite chunking warnings and the same Node engine warning.
- Did not run `electron-builder`.
- No commit was created.

# Stage 2b Codex Report

## Files changed

- `src/main/migrate-dobius-data-files.ts`
- `src/main/index.ts`
- `src/main/persistence.ts`
- `src/main/stats/collector.ts`
- `src/main/runtime/mobile-pairing-files.ts`
- `src/main/claude-usage/store.ts`
- `src/main/codex-usage/store.ts`
- `src/main/opencode-usage/store.ts`
- `src/shared/runtime-bootstrap.ts`
- `src/main/startup/configure-process.ts`
- `src/cli/handlers/agent-hooks.ts`
- `src/cli/runtime/metadata.ts`
- `src/cli/handlers/agent-hooks.test.ts`
- `src/main/persistence.test.ts`
- `src/main/codex-usage/store.test.ts`
- `src/main/runtime/runtime-metadata.test.ts`
- `src/cli/runtime-client.test.ts`
- `src/cli/runtime/client-timeout-policy.test.ts`
- `src/main/startup/configure-process.test.ts`
- `src/main/runtime/mobile-pairing-userdata-path.test.ts`
- `src/main/startup/single-instance-lock.ts`
- `src/shared/types.ts`

## Migration function and call site

- Added `migrateDobiusDataFilesToDobius()` in `src/main/migrate-dobius-data-files.ts`.
- The migration runs inside `app.whenReady()` immediately after `migrateDobiusHomeDirToDobius()` and before `new Store()`.
- It uses `app.getPath('userData')`, skips missing sources, skips when the destination already exists, uses `renameSync`, and logs failures without throwing.
- Persisted files migrated:
  - `dobius-data.json` -> `dobius-data.json`
  - `dobius-stats.json` -> `dobius-stats.json`
  - `dobius-devices.json` -> `dobius-devices.json`
  - `dobius-e2ee-keypair.json` -> `dobius-e2ee-keypair.json`
  - `dobius-claude-usage.json` -> `dobius-claude-usage.json`
  - `dobius-codex-usage.json` -> `dobius-codex-usage.json`
  - `dobius-opencode-usage.json` -> `dobius-opencode-usage.json`
- Rolling backups migrated for `dobius-data.json.bak.0` through `.bak.4`.
- Ephemeral `dobius-github-cache.json` and `dobius-runtime.json` are not migrated.

## CLI folder fix

- Updated `src/cli/runtime/metadata.ts` default userData folder from `dobius` to `Dobius+` for macOS, Windows, and Linux.
- Left `DOBIUS_USER_DATA_PATH` override behavior unchanged for dev and parallel instance targeting.

## Tests updated

- Updated old userData filename literals in the requested CLI, persistence, runtime metadata, runtime client, timeout policy, configure process, and Codex usage tests.
- Also updated stale userData filename comments in nearby docs/tests so they refer to the new `dobius-*.json` files.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.
- Both commands emitted the existing engine warning because this shell is running Node `v26.0.0` while `package.json` requests Node `24`.
- The build also emitted normal Vite chunking warnings; exit code was 0.

## Unsure

- Nothing currently unsure.

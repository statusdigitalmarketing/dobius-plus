# Stage 1 Dobius+ Migration Report

## Files Changed

- `src/main/agent-hooks/installer-utils.ts`
- `src/main/antigravity/hook-service.ts`
- `src/main/asana/asana-token-store.ts`
- `src/main/claude/hook-service.ts`
- `src/main/codex/hook-service.ts`
- `src/main/command-code/hook-service.ts`
- `src/main/copilot/hook-service.ts`
- `src/main/cursor/hook-service.ts`
- `src/main/devin/hook-service.ts`
- `src/main/devin/hook-settings.ts`
- `src/main/gemini/hook-service.ts`
- `src/main/grok/hook-service.ts`
- `src/main/index.ts`
- `src/main/jira/client.ts`
- `src/main/keybindings/keybinding-file.ts`
- `src/main/kimi/hook-service.ts`
- `src/main/linear/client.ts`
- `src/main/migrate-dobius-home-dir.ts`
- `src/main/minimax/minimax-cookie-store.ts`
- `src/main/runtime/claude-agent-teams-shim-env.ts`
- `src/main/speech/openai-api-key-store.ts`
- `src/renderer/src/components/settings/OpenAiTranscriptionKeyDialog.tsx`
- `src/renderer/src/components/settings/ShortcutsPane.tsx`
- `plans/STAGE1-CODEX-REPORT.md`

## Migration Function

Added `migrateDobiusHomeDirToDobius()` in `src/main/migrate-dobius-home-dir.ts`.

The function renames `~/.dobius` to `~/.dobius` when `~/.dobius` exists and `~/.dobius` does not. The rename is fail-open so launch continues if the move fails.

## Migration Call Site

Called `migrateDobiusHomeDirToDobius()` at the start of the `app.whenReady()` startup path in `src/main/index.ts`, immediately after the `app-ready` milestone and before `Store`, keybindings, token stores, and `runManagedHookInstallers(...)` are initialized.

## Verification

- `node config/scripts/verify-localization-catalog.mjs --fix`: passed.
- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.

Both pnpm commands emitted the existing Node engine warning because this shell is using Node v26.0.0 while the package requests Node 24. The Electron Vite build also emitted existing dynamic-import chunking warnings.

## Notes

- Confirmed `src/main/agent-hooks/remote-managed-hook-installers.ts` does not hard-code remote `~/.dobius/agent-hooks` paths.
- Confirmed `amp`, `hermes`, and `droid` hook services do not write remote `~/.dobius/agent-hooks` paths directly. `openclaude` uses `ClaudeHookService`, whose remote path was updated.
- No implementation uncertainties remain.

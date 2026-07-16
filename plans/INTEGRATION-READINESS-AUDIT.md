# Integration Readiness Audit

Date: 2026-07-09

Scope: Dobius+ integration readiness after the UI uplift. The root package scripts now delegate the default app commands to the nested `dobius/` Electron app, which matches the uplift screenshot. Knowledge page implementation files were not edited because another agent is working there.

## Shipping Surface

The nested `dobius/` Electron app is now the default shipping surface from the repository root:

- `npm run dev` delegates to `pnpm --dir dobius dev`.
- `npm run build` delegates to `pnpm --dir dobius build`.
- `npm run start` delegates to `pnpm --dir dobius start`.
- Legacy root app commands remain available under `legacy:*`.

The `ui uplift/` Automations UI matches the nested `dobius/` Automations surface in the provided screenshot. The nested app has the real preload/API bridge, lazy routes, store actions, and built chunks for Automations and Settings.

## Fixed Wiring Issues

### Root scripts pointed at the old shell

File:

- `package.json`

Problem: root `dev`, `build`, `start`, and Electron scripts still launched the legacy root app, so the uplift UI shown in the screenshot was not the default app path.

Fix: default root scripts now delegate to `dobius/`. Legacy root scripts were preserved as `legacy:*` so the old app is still runnable for comparison.

### Settings rebrand and verification

Files:

- `dobius/src/renderer/src/components/settings/*`
- `dobius/src/renderer/src/App.tsx`
- `dobius/src/renderer/src/main.tsx`
- `dobius/src/renderer/src/web/*`
- `dobius/src/renderer/index.html`
- `dobius/src/renderer/web-index.html`

Problem: Settings and app-shell copy still exposed stale pre-Dobius product text after the Dobius+ UI uplift. Settings tests also asserted the old copy, which masked the actual Settings wiring signal.

Fix: visible renderer/settings copy was updated to `Dobius+`, Settings tests were updated to match, and the remaining runtime/CLI/protocol/config contracts were moved to Dobius names.

### Cross-project session resume

Files:

- `src/store/store.js`
- `src/components/Dashboard/Search.jsx`
- `src/components/Dashboard/Sessions.jsx`
- `src/components/Project/ResumeBanner.jsx`

Problem: dashboard-wide session surfaces had `projectPath` available but resumed by `sessionId` only, causing `claude --resume` to run in the currently active terminal cwd.

Fix: `resumeSession` now accepts either a legacy bare `sessionId` or `{ sessionId, projectPath }`. Search, Sessions, and ResumeBanner pass project context so resume commands run as:

```sh
cd '<projectPath>' && claude --resume <sessionId>
```

The command path is validated and single-quote escaped before writing to the terminal.

### Orchestrator run finalization

File:

- `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`

Problem: when Claude status hooks marked a subtask tab `done`, the UI updated that subtask but did not mark the whole orchestration run `completed` or `failed`. Runs could remain persisted as `running` even after all subtasks finished.

Fix: the completion path now computes all subtask terminal states, sets run `status`, writes `completedAt`, updates Zustand, and persists the final run.

### Orchestrator CTA label

File:

- `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`

Problem: the primary button said `Decompose & Launch`, but the action only decomposes and requires the follow-up `Launch All` action.

Fix: label changed to `Decompose`.

### Orchestration summary extraction

File:

- `src/components/Project/ProjectView.jsx`

Problem: terminal scrollback was treated as a string, but `terminalLoadState()` returns `scrollback` as an array.

Fix: scrollback is joined before ANSI stripping and summary extraction.

## Existing OrchestratorView Changes

`src/components/Dashboard/Orchestrator/OrchestratorView.jsx` already had working-tree changes before this audit patch. Those include:

- `waitForClaudeProcess`
- result-path prompting through `orchestrationResultPath`
- stronger agent instructions to write verified result files
- Claude startup verification after launch

Those existing changes were not reverted or rewritten. This audit patch only builds on the current file state to fix completion/finalization and the misleading CTA label.

## Settings Readiness

Settings is usable on the uplift path:

- Settings is lazy-loaded from `dobius/src/renderer/src/App.tsx`.
- Sidebar/help menu entries call `openSettingsPage()` and optional `openSettingsTarget()`.
- Startup calls `fetchSettings()` before repo/worktree hydration.
- Renderer updates call `window.api.settings.set()`.
- Main process registers `settings:get`, `settings:set`, font listing, theme import previews, and `settings:changed` broadcast.
- Main process applies side effects for theme, app icon, proxy, language, agent hooks, menu appearance, awake behavior, and workspace root watchers.

No dead Settings controls were found in the focused audit. The only failed Settings checks were stale rebrand assertions; those are now fixed.

## Deferred Items

### Scheduled task desktop UI

Status: deferred.

Reason: scheduled task engine functions exist and are reachable through voice/mobile bridge paths, but no root desktop UI was added in this pass.

Required fix if desktop control is required:

- Add preload/main IPC for scheduled task list/update.
- Add Settings or Automation UI controls.
- Validate task enable/disable persists to `config.scheduledTasks`.

## Verification

Commands run:

```sh
pnpm --dir dobius run typecheck
pnpm --dir dobius exec vitest run --config config/vitest.config.ts src/renderer/src/components/settings
pnpm --dir dobius run build:electron-vite
npm run legacy:build
node electron/task-pipeline.test.js
node -e "<IPC parity check>"
git diff --check
```

Results:

- Nested Dobius+ typecheck passed.
- Settings component/store/API tests passed: 88 files, 532 tests.
- Nested Electron/Vite production build passed; Automations and Settings chunks were emitted.
- Legacy root production build passed.
- Task pipeline tests passed: 19/19.
- IPC parity passed: no missing handlers, no unexposed handlers.
- Diff whitespace check passed.

## Push Risk

Remaining notable risk before push: the working tree still contains many unrelated changes outside this audit, including the nested `dobius/` app and existing `OrchestratorView.jsx` edits that predated this pass. Do not PR unrelated deletions or other-agent Knowledge work accidentally.

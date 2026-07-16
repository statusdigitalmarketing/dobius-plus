# Tear-Off Terminal Report

## Summary

Implemented v1 terminal tear-off on branch `feat/agents-page` without committing.

The feature adds:
- PTY output/exit broadcast to all registered app renderer windows.
- A validated `window:tearOffTerminal` IPC path that opens a separate `BrowserWindow`.
- A renderer hash mode that mounts a single reused `TerminalPane` instead of the full app shell.
- Context-menu fallback: `Open in new window`.
- Drag-out trigger from dnd-kit tab drag end when the pointer finishes outside the renderer viewport.
- Kill-on-close for only the torn-off PTY id.

No `knowledge/*` files were touched.

## Broadcast Change

Added `src/main/window/renderer-window-registry.ts` with:
- `registerRendererWindow(win)`
- `rendererWindowContents()`

`createMainWindow.ts` registers the primary window immediately after creation. Torn-off windows register when created.

`src/main/ipc/pty.ts` now sends `pty:data` and `pty:exit` to `rendererWindowContents()` instead of only `mainWindow.webContents`. Payloads are unchanged. With zero tear-off windows, the only registered renderer is still the main window, so the output path is byte-identical from the renderer perspective: same channel, same payload, same filtering by PTY id.

Safety note in code: broadcast is fine for 1-3 app windows because each renderer already demuxes by `id`; if window count grows, this should become a per-PTY routing map.

## New Window Creation And WebPreferences

Added `src/main/window/tear-off-window.ts`.

Validation:
- `tabId` must pass `isValidTerminalTabId`.
- `ptyId` must pass `hasLivePty(ptyId)`.
- No renderer-supplied file path or URL is loaded.

`createMainWindow.ts` now exports `createAppRendererWebPreferences()`, which returns the same preload/security options the main window used:
- `preload: join(__dirname, '../preload/index.js')`
- `sandbox: true`
- `webviewTag: true`

The tear-off window calls that helper, so the security settings stay in lockstep.

Renderer load mode:
- Dev: `${ELECTRON_RENDERER_URL}#terminal-tab=<tabId>&pty=<ptyId>&title=<enc>`
- Prod: `loadFile(index.html, { hash })`

Close behavior:
- On torn-off window `closed`, it checks `hasLivePty(ptyId)` and calls exported `killPty(ptyId)`.
- `killPty` is backed by the existing `pty:kill` shutdown path in `pty.ts`; it does not invent a second teardown path.
- It targets only the specific `ptyId` captured for that window.

## Renderer Mode Switch

Added `src/renderer/src/torn-off-terminal-entry.ts`:
- Parses `#terminal-tab=...&pty=...&title=...`.
- Rejects invalid tab ids and missing PTY ids.

`src/renderer/src/main.tsx` now mounts `<TornOffTerminalRoot />` instead of `<App />` when that hash is present.

Provider subset included:
- `I18nProvider` remains in `main.tsx` around both modes.
- `RecoverableRenderErrorBoundary` remains around both modes.
- `TooltipProvider`, because `TerminalPane` and terminal chrome use tooltips.
- `ConfirmationDialogProvider`, because terminal close/context flows can use confirmation context.
- `LinkRoutingPreferenceDialogProvider`, because terminal links call `useLinkRoutingPreferenceDialog`.
- `Toaster`, because terminal errors/toasts use sonner.

Not included:
- Sidebar, titlebar, workspace shell, updater gates, runtime sync gates, workspace port scanner, recent-tab switcher, onboarding, and app-global sidebar workflows.

## Terminal Binding And Scrollback

Added `src/renderer/src/components/terminal-pane/TornOffTerminalRoot.tsx`.

It seeds a minimal in-memory Zustand state for the secondary renderer:
- one `TerminalTab`
- one unified terminal tab
- one tab group
- one terminal layout leaf
- `ptyIdsByLeafId` mapping the leaf to the live `ptyId`
- `ptyIdsByTabId` containing that same `ptyId`

It then renders the existing `TerminalPane` directly. This keeps:
- xterm ownership in the existing leaf-level lifecycle.
- normal PTY input/write IPC.
- normal resize IPC.
- normal hidden-buffer/snapshot replay path inside `connectPanePty` / `useTerminalPaneLifecycle`.
- normal `pty:exit` handling, with a small session-ended overlay for this window.

## Gesture And Context Menu

Added `src/renderer/src/components/tab-bar/terminal-tab-tear-off.ts`.

It:
- resolves the tab's live PTY id from layout bindings, `ptyIdsByTabId`, and tab fallback `ptyId`.
- calls `window.api.window.tearOffTerminal`.
- on `{ ok: true }`, removes this renderer's tab/layout ownership records without killing the PTY.

Context menu:
- `SortableTabContextMenu` has `Open in new window`.
- `TabBar` wires terminal tabs to `tearOffTerminalTab(tab.id)`.

Drag-out:
- `useTabDragSplit` checks terminal tab drag end.
- If there is no in-app drop target and the final pointer is outside `window.innerWidth/innerHeight` with an 8px margin, it calls the same helper.
- Existing in-window reorder/split/drop logic remains before/after that path as appropriate.

## Files Changed

Added:
- `src/main/window/renderer-window-registry.ts`
- `src/main/window/renderer-window-registry.test.ts`
- `src/main/window/tear-off-window.ts`
- `src/main/window/tear-off-window.test.ts`
- `src/renderer/src/torn-off-terminal-entry.ts`
- `src/renderer/src/torn-off-terminal-entry.test.ts`
- `src/renderer/src/components/terminal-pane/TornOffTerminalRoot.tsx`
- `src/renderer/src/components/tab-bar/terminal-tab-tear-off.ts`

Modified:
- `src/main/ipc/pty.ts`
- `src/main/window/createMainWindow.ts`
- `src/main/window/attach-main-window-services.ts`
- `src/preload/index.ts`
- `src/preload/api-types.ts`
- `src/renderer/src/web/web-preload-api.ts`
- `src/renderer/src/main.tsx`
- `src/renderer/src/components/tab-bar/TabBar.tsx`
- `src/renderer/src/components/tab-bar/SortableTab.tsx`
- `src/renderer/src/components/tab-bar/SortableTabContextMenu.tsx`
- `src/renderer/src/components/tab-group/useTabDragSplit.ts`

## Verification

Focused tests:

```text
pnpm exec vitest run src/renderer/src/torn-off-terminal-entry.test.ts src/main/window/renderer-window-registry.test.ts src/main/window/tear-off-window.test.ts

Test Files  3 passed (3)
Tests       9 passed (9)
```

Typecheck:

```text
pnpm run typecheck

exit 0
```

Build:

```text
pnpm run build:electron-vite

exit 0
```

Notes:
- Commands emitted the existing Node engine warning: repo wants Node 24; environment has Node v26.0.0.
- `build:electron-vite` emitted existing Vite dynamic/static import chunking warnings.
- No `knowledge/*` errors appeared.

## Uncertainties

- I did not perform a live manual Electron drag/tear-off run in the UI. Verification is static, unit, typecheck, and production build.
- `TornOffTerminalRoot` reuses `TerminalPane` with a seeded minimal store. Type/build checks confirm it compiles outside the app shell, and the included providers cover the direct contexts it uses, but a live run is still the best confirmation that no app-shell-only runtime side effect is implicitly required.
- The drag-out trigger depends on dnd-kit producing no `event.over` when the pointer leaves the renderer content. The context-menu fallback guarantees the feature remains reachable if platform/window-manager drag behavior is finicky.

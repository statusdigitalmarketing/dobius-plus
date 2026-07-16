# Floating Phone Code Report

## Window Options

- Added `src/main/window/floating-phone-window.ts`.
- Creates a singleton `BrowserWindow` with `frame:false`, `transparent:true`, `alwaysOnTop:true`, `resizable:true`, `hasShadow:false`, `skipTaskbar:false`, min size `300x560`, default size `390x820`.
- On macOS, calls `setAlwaysOnTop(true, 'floating')`.
- Initial bounds are placed near the cursor and clamped to the nearest display work area. Bounds are also kept in a module-level variable on move/resize.
- Uses `createAppRendererWebPreferences()`, `registerRendererWindow(win)`, title pinning, hash loading, and the did-finish-load focus + 1px nudge pattern from terminal tear-off.

## Shared Webview Hardening

- Extracted the existing main-window `will-attach-webview` and `did-attach-webview` policy into `src/main/window/webview-hardening.ts`.
- `createMainWindow.ts` now calls `attachWebviewHardening(mainWindow.webContents)`.
- The floating phone window also calls `attachWebviewHardening(win.webContents)`.
- Main-window behavior is intended to remain unchanged: the moved code preserves the same URL normalization, partition allowlist check, preload/preloadURL deletion, Node disablement, sandbox/contextIsolation/webSecurity settings, shared guest webpreferences assignment, partition preservation, and `browserManager.attachGuestPolicies(guest)`.

## Hash Contract

- Main loads phone windows with `phone-visual=1&mode=<web|app>&worktree=<encoded>&url=<encoded>`.
- `worktree` and `url` are optional.
- Main validates mode and accepts only `http:`/`https:` URLs.
- Renderer parser is in `src/renderer/src/floating-phone-entry.ts` and rejects missing markers, invalid modes, and unsafe schemes.

## Web/App Mode Wiring

- Renderer startup checks torn-off terminal first, then floating phone, then the normal app shell.
- `FloatingPhoneRoot` renders one phone bezel with a compact toolbar and mode toggle.
- WEB mode creates an Electron `<webview>` guest imperatively with:
  - `partition="persist:dobius-browser"`
  - `allowpopups`
  - shared browser guest webpreferences attribute
  - iPhone Safari-style mobile user agent
  - default URL `http://localhost:3000`
- APP mode uses `useEmulatorPaneSession({ worktreeId, tabId: 'floating-phone-emulator', autoAttachOnMount: true })` and renders `EmulatorDeviceFrame`.
- If no worktree is supplied, APP mode shows `Open from a project to attach the emulator`.

## Hardware Buttons

- Floating-phone-only controls were added in `FloatingPhoneHardwareControls`.
- Interactive:
  - Home: sends `emulator.button` with `home` through the existing session controls, APP mode only when live.
  - Power: closes the sender window through `phone-visual:close`.
- Decorative:
  - Action button
  - Volume up
  - Volume down
- The embedded `EmulatorPane` and its decorative `PhoneHardwareButtons` were not changed.

## Bounds Persistence

- Main persists bounds for this app process via module-level state on `moved`/`resized`.
- Renderer stores/restores last known bounds in `localStorage` under `floating-phone-bounds` and sends them on mount through `phone-visual:setBounds`.
- This is a small v1 approach; app-restart restoration depends on renderer localStorage, while accurate move tracking during a process lifetime is handled in main.

## Singleton Behavior

- A module-level `floatingPhoneWindow` prevents multiple phone windows.
- Reopening focuses the existing phone.
- If args differ, main sends `phone-visual:update` to the existing window and updates mode/worktree/url state in the renderer.

## Files Added/Changed

- Added `src/shared/floating-phone.ts`.
- Added `src/main/window/floating-phone-window.ts`.
- Added `src/main/window/webview-hardening.ts`.
- Changed `src/main/window/createMainWindow.ts`.
- Changed `src/main/window/attach-main-window-services.ts`.
- Changed `src/preload/api-types.ts`, `src/preload/index.ts`, and `src/renderer/src/web/web-preload-api.ts`.
- Added `src/renderer/src/floating-phone-entry.ts` and `.test.ts`.
- Added `src/renderer/src/components/floating-phone/*`.
- Changed `src/renderer/src/main.tsx`.
- Changed `src/renderer/src/components/right-sidebar/index.tsx`.

## Verification

- `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/floating-phone-entry.test.ts`: passed, 7 tests.
- `pnpm exec oxlint <touched files>`: passed.
- File line counts: all new files under 300 counted lines.
- `pnpm run typecheck`: passed. Warning: current Node is `v26.0.0`; package wants Node `24`.
- `pnpm run build:electron-vite`: passed. Vite emitted existing dynamic-import chunk warnings.

## Uncertainties

- Transparent + frameless rounded rendering on macOS was not visually verified.
- The iPhone Safari user-agent behavior in Electron webviews was not visually verified.
- Emulator attach/control from a secondary renderer window was type/build verified but not visually exercised against a live emulator.
- WEB mode webview guest hardening is wired through the shared main-process policy, but no runtime guest-attach inspection was performed.

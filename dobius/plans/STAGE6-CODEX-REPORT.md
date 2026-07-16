# Stage 6 Codex Report

## Change List

- Updated packaged Electron app id in `config/electron-builder.config.cjs` to `com.statusdigitalmarketing.dobius-plus`.
- Updated the base app user model id in `src/main/startup/dev-instance-identity.ts` to `com.statusdigitalmarketing.dobius-plus`; dev ids now derive from `com.statusdigitalmarketing.dobius-plus.dev.<hash>`.
- Updated the packaged macOS notification bundle id in `src/main/ipc/notifications.ts` to `com.statusdigitalmarketing.dobius-plus`.
- Updated the default computer-use helper bundle id in `src/main/computer/macos-computer-use-permissions.ts` to `com.statusdigitalmarketing.dobius-plus.computer-use`.
- Updated the default helper bundle id in `config/scripts/build-computer-macos.mjs` to `com.statusdigitalmarketing.dobius-plus.computer-use`, while keeping the `DOBIUS_COMPUTER_MACOS_BUNDLE_ID` override name unchanged.
- Updated the macOS dev wrapper bundle id template in `config/scripts/run-electron-vite-dev.mjs` to `com.statusdigitalmarketing.dobius-plus.dev.<hash>`.
- Updated the Swift computer-use caller allowlist in `native/computer-use-macos/Sources/DobiusComputerUseMacOS/main.swift` to trust `com.statusdigitalmarketing.dobius-plus` and `com.statusdigitalmarketing.dobius-plus.dev.` callers.
- Updated tests that asserted the old app/dev bundle ids.
- Updated macOS launch diagnostics log predicates from the old bundle id to `com.statusdigitalmarketing.dobius-plus`.
- Removed stale generated helper app bundles under `native/computer-use-macos/.build/x86_64-apple-macosx/release` that still contained the old helper bundle id before rebuilding.

## Zero-Leftover Grep

Command:

```sh
grep -RIn "com\.statusdigitalmarketing\.dobius" src config native 2>/dev/null || true
```

Result: no matches.

## Native Helper Bundle Identifier

Rebuilt with:

```sh
pnpm build:computer-macos
```

Verified with:

```sh
/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "native/computer-use-macos/.build/release/Dobius+ Computer Use.app/Contents/Info.plist"
```

Result:

```text
com.statusdigitalmarketing.dobius-plus.computer-use
```

## Verification

- `pnpm run typecheck`: passed, exit 0.
- `pnpm run build:electron-vite`: passed, exit 0.
- `pnpm build:computer-macos`: passed, exit 0.

Notes:

- The pnpm commands emitted the existing engine warning because this shell is using Node `v26.0.0` while `package.json` requests Node `24`.
- `pnpm build:computer-macos` emitted the existing Swift deprecation warning for `CGWindowListCreateImage` on macOS 14.

## Human Follow-Up Note

After this lands, the app's installed Info.plist CFBundleIdentifier must be changed to `com.statusdigitalmarketing.dobius-plus` and the app re-signed. macOS will then treat it as a new app and all permissions (Full Disk Access, Automation, Screen Recording, Accessibility) must be re-granted, and safeStorage secrets may need re-entry.

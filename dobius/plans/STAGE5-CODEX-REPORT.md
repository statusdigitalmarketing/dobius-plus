# Stage 5 Dobius+ Migration Report

## Lockstep Bundle Rename

Renamed the functional macOS helper bundle folder from `Dobius Computer Use.app` to `Dobius+ Computer Use.app` in all required lockstep locations:

1. `config/scripts/build-computer-macos.mjs`: `appPath` now produces `native/computer-use-macos/.build/release/Dobius+ Computer Use.app`.
2. `config/scripts/build-computer-macos.mjs`: `displayName` is now `Dobius+ Computer Use` for `CFBundleName` and `CFBundleDisplayName`.
3. `config/electron-builder.config.cjs`: macOS extra resource `from` now copies from `native/computer-use-macos/.build/release/Dobius+ Computer Use.app`.
4. `config/electron-builder.config.cjs`: macOS extra resource `to` now packages as `Dobius+ Computer Use.app`.
5. `config/electron-builder.config.cjs`: nested helper signing now signs `join(resourcesDir, 'Dobius+ Computer Use.app')`.
6. `src/main/computer/macos-native-provider-paths.ts`: packaged helper path now resolves `Dobius+ Computer Use.app`.
7. `src/main/computer/macos-native-provider-paths.ts`: dev `process.cwd()` helper path now resolves `Dobius+ Computer Use.app`.
8. `src/main/computer/macos-native-provider-paths.ts`: dev `__dirname` helper path now resolves `Dobius+ Computer Use.app`.
9. `config/scripts/verify-computer-native.mjs`: codesign verification now expects `Dobius+ Computer Use.app`.

The inner executable and Swift product identifiers were not renamed: `dobius-computer-use-macos` and `DOBIUS_COMPUTER_MACOS_*` remain unchanged.

## Consistency Edits

Updated user-facing helper names from `Dobius Computer Use` to `Dobius+ Computer Use` in:

- Info.plist accessibility and screen recording usage descriptions.
- Runtime unavailable and permission error strings.
- CLI permission setup output.
- Swift helper UI text and permission prompts.
- Tests that hardcoded the helper bundle/display name.

Left `tests/e2e/helpers/computer-driver.ts` unchanged because its old string is an unrelated document-title fixture.

## Native Rebuild

`pnpm build:computer-macos` exited 0 and produced:

- `native/computer-use-macos/.build/release/Dobius+ Computer Use.app`
- `native/computer-use-macos/.build/release/Dobius+ Computer Use.app/Contents/MacOS/dobius-computer-use-macos`

The Swift build emitted an existing macOS deprecation warning for `CGWindowListCreateImage`.

## Verification

- `pnpm build:computer-macos`: exit 0.
- `pnpm run typecheck`: exit 0.
- `pnpm run build:electron-vite`: exit 0.

All pnpm commands emitted the existing engine warning: wanted Node `24`, current Node `v26.0.0`.

`electron-builder` was not run.

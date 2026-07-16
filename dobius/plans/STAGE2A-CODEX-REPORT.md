# Stage 2a Codex Report

## Files Changed

- `src/main/startup/dev-instance-identity.ts`
  - Renamed `BASE_APP_NAME` from `Dobius` to `Dobius+`.
  - Left `BASE_APP_USER_MODEL_ID` unchanged as `com.statusdigitalmarketing.dobius`.
- `src/main/startup/configure-process.ts`
  - Imported and called `migrateUserDataFolderName()`.
  - Changed normal dev `userData` from `dobius-dev` to `Dobius+-dev`.
- `src/main/startup/migrate-userdata-folder.ts`
  - Added the fail-open userData folder name migration.

## Migration Function

- `migrateUserDataFolderName()` is defined in `src/main/startup/migrate-userdata-folder.ts:10`.
- It uses `app.getPath('appData')` as the base directory.
- It migrates these folder pairs when the old folder exists and the new folder does not:
  - `dobius-dev` -> `Dobius+-dev`
  - `Dobius` -> `Dobius+`
- It uses `renameSync(oldDir, newDir)` for whole-folder moves.
- It catches rename failures, logs `[migrate-userdata] could not move ...`, and never throws.

## Exact Call Site

- `src/main/startup/configure-process.ts:202`
  - `migrateUserDataFolderName()` runs inside `configureDevUserDataPath(isDev)`.
  - It runs after the E2E and explicit dev override early returns.
  - It runs before the packaged `!isDev` return and before normal dev sets `userData` to `Dobius+-dev`.

`configureDevUserDataPath(is.dev)` is still called from `src/main/index.ts` before `initDataPath()` and before `new Store()`, so the folder migration runs before the Store reads persisted state.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm run build:electron-vite`: passed.

Both commands emitted the existing Node engine warning because this shell uses Node v26 while `package.json` requests Node 24.

## Behavior Note

On next normal dev launch, the dev userData folder will move from `dobius-dev` to `Dobius+-dev` when `dobius-dev` exists and `Dobius+-dev` does not.

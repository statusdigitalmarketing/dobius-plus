# HANDOFF — Dobius+

Last updated: 2026-06-21

## Current state (the one thing that matters)
All fixes are **committed in source at v1.0.24**. They are **NOT installed** — the app in `/Applications` is still **v1.0.22** (predates the fixes). Only remaining action: **build + install v1.0.24** (`./build-and-install.sh`).

| | Version | Has crash fixes? |
|---|---|---|
| Source / git HEAD | v1.0.24 | YES (committed in `d24dc58 v1.0.23: four critical fixes`, then 8 rounds of Claude+Codex review) |
| Installed app | v1.0.22 | NO |

## The three bugs (fixes committed)
1. **Blank terminals / can't start or resume Claude** — node-pty `spawn-helper` lost its execute bit in the v1.0.22 build (electron-builder asar-unpack drops +x; scp/rsync/chmod could too). Fixed by: `ensureSpawnHelperExecutable()` startup self-heal + `build/after-pack.cjs` afterPack hook (restores +x at build time).
2. **Clicking Dashboard crashed the app (main-process OOM, SIGTRAP)** — `DashboardView` mount -> `loadAllSessions()` read + fully JSON-parsed the ENTIRE `~/.claude` history (927MB / 6,773 files) at once. Fixed by: `parseJsonl` tail-read (`readTail()`, bounded) + `mapLimit(..., 24)` bounded pool in `loadAllSessions`.
3. (Lower priority, NOT addressed) older SIGABRT = node-pty aborting during app quit.

## What's done (committed + verified)
- `electron/data-utils.js` — `parseJsonl` tail-read when `limit > 0` (`readTail()`, 64KB backward chunks, 4MB cap) + `mapLimit(items, limit, fn)`. Verified: identical last-5/last-100 vs old, +0MB vs +95MB on a 24MB file.
- `electron/data-service.js` — `loadAllSessions` uses `mapLimit(..., 24, ...)` instead of unbounded nested `Promise.all`.
- `electron/terminal-manager.js` — `ensureSpawnHelperExecutable()` startup self-heal.
- `electron/main.js` — calls it first in `whenReady`; `setupCrashLogging()` -> `userData/crash.log`.
- `build/after-pack.cjs` + `electron-builder.yml` (`afterPack: build/after-pack.cjs`) — restores spawn-helper +x at build, before signing.
- `LESSONS-LEARNED.md` — Build + Performance lessons.

## Build Passes: YES

---

## Handoff update — 2026-06-13 (scaffolding)

**Done:**
- `.claude/CLAUDE.md` (Claude workflow layer) in place.
- `.claude/settings.json` created with scoped permissions: allows `dev`, `build`, `build:mobile`, `electron:dev`, `start`, read-only git (`status`, `diff`, `log`), and `npx electron-rebuild`. Denies `npm run electron:build` (signed/notarized release — human-only) and `./build-and-install.sh` (rm -rf + install to /Applications — human-only).
- Scaffolding files (LESSONS-LEARNED.md, BUILD-LOG.md, HANDOFF.md) updated with a dated section each.

**In progress:**
- ~27 uncommitted files — the in-flight dashboard feature. Untracked: `electron/file-change-service.js`, `src/components/Dashboard/{ChangeFeed,Costs,Prompts,Search}.jsx`, `src/components/Launcher/ProjectContextMenu.jsx`. Plus 21 modified (Dashboard views, store.js, electron data/preload/window/voice services, several launcher/project/shared components, AUTONOMOUS-BUILD.md, package-lock.json).
- Branch: `feature/multi-account-cli-path`, last commit `d082675`.

**Next:**
- Review and branch the in-flight dashboard work deliberately before starting new builds. Do not blow it away; confirm intent before committing or branching over it.

**Known issues / cautions:**
- See `LESSONS-LEARNED.md` (incl. the 2026-06-13 audit section) for runtime/build gotchas: null bytes in `execFile`, dev process name `"Electron"`, `build-and-install.sh` rm -rf, mounted-tab requirement, native-module rebuild, remote-debugging-port pre-ship check, config.json not hand-editable.
- `npm run electron:build` and `./build-and-install.sh` are human-initiated only and are denied in `.claude/settings.json`.

---

## What's next (in order)
1. **Build + install v1.0.24**: `./build-and-install.sh`. This installs the fixes over the old 1.0.22 and bakes in the afterPack +x. A clean rebuild also drops the leftover `app.asar.unpacked.bak-precompletedfix/` junk shipped in the current bundle.
2. **Ship-test after install**: open the Dashboard with the full 927MB history present, confirm no crash + sessions list populates. Confirm a fresh terminal tab + `claude --resume` works.
3. Done — v1.0.24 already committed; just needs the build.

## State of the running app right now
- Terminals work (installed v1.0.22 spawn-helper is executable; the 06-12 chmod held).
- Dashboard OOM fix is NOT live yet (installed app is pre-fix). Avoid opening the Dashboard until v1.0.24 is built + installed.

## Note
- Sam's buddy SSH'd into the box pulling files; code signature verified intact (no corruption), nothing world-writable. Audit that script if/when available.

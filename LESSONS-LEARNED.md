# Lessons Learned — Dobius+

> This file is READ at the start of every session and APPENDED TO whenever a mistake is made or a non-obvious pattern is discovered.
> It accumulates institutional knowledge across sessions. Never delete entries — only mark outdated ones.

---

<!-- New lessons are appended below this line -->

### [Deployment] — 2026-04-30
- **MISTAKE**: Released v1.0.3 with the auto-updater wired up, but Brett's app silently failed to update. The bug: `latest-mac.yml` referenced `dobius-plus-1.0.3-arm64-mac.zip` while the actual uploaded file was `Dobius+-1.0.3-arm64-mac.zip`. The download URL 404'd, so `electron-updater` aborted silently with no user-visible error.
- **FIX**: `electron-builder` defaults the `artifactName` to use `${productName}` ("Dobius+") for filenames, but writes `latest-mac.yml` URLs using `${name}` ("dobius-plus") from `package.json`. They never match unless you pin `artifactName` explicitly. Added to `electron-builder.yml`:
  ```yaml
  mac:
    artifactName: ${name}-${version}-${arch}-mac.${ext}
  dmg:
    artifactName: ${name}-${version}.${ext}
  ```
  After this, the YAML's `url:` fields match the actual filenames. v1.0.4+ ships clean. v1.0.3 was patched by re-uploading renamed copies via `gh release upload --clobber`.
- **CONTEXT**: This is silent — there is no warning at build time, no error in the published release, nothing in `electron-updater`'s logs unless you enable verbose logging. The only way to detect it is to fetch `latest-mac.yml` from the release and HEAD-check each `url:` field.
- **DETECTION**: `python3 -c "import urllib.request; print(urllib.request.urlopen('https://github.com/statusdigitalmarketing/dobius-plus/releases/latest/download/latest-mac.yml').read().decode())"` — confirm each `url:` line is a filename that exists in the release assets list (`gh release view vX.Y.Z --json assets --jq '.assets[].name'`).

### [Build] — 2026-04-30
- **MISTAKE**: `electron-builder` v26 doesn't auto-sign the DMG container. The .app inside is signed and notarized via the build, but double-clicking the DMG itself triggers a Gatekeeper warning because the wrapper isn't signed. Caught by Brett seeing "Apple could not verify..." after his first install attempt.
- **FIX**: Manual post-build step — `codesign --sign <hash> --timestamp <dmg>`, then `xcrun notarytool submit --wait`, then `xcrun stapler staple`. See RELEASING.md step 3. Until automated, this MUST happen for every release or first-time installs will hit the warning.
- **CONTEXT**: The .app inside the DMG passes Gatekeeper because notarization stapled to it. But macOS's `spctl -a -t install` evaluates the DMG container separately. `electron-builder` v26 has no built-in toggle to sign the DMG; it's a known limitation.
- **DETECTION**: `spctl -a -vvv -t install dist-electron/dobius-plus-*.dmg` — should report `accepted, source=Notarized Developer ID`. If it says `rejected, source=no usable signature`, the DMG wasn't signed.

### [Configuration] — 2026-04-30
- **MISTAKE**: Used `notarize: { teamId: "..." }` (object form) in `electron-builder.yml`. electron-builder v26 changed the schema — `notarize` is now a boolean only. Build failed with `notarize: should be a boolean`.
- **FIX**: Use `notarize: true`. Team ID comes from the `APPLE_TEAM_ID` env var, not the YAML.
- **CONTEXT**: This is a v25 → v26 breaking change. The `notarize` object form was the recommended config for v25 and earlier; older docs/blog posts still show that.
- **DETECTION**: Build error message mentions `notarize: should be a boolean`. Or grep electron-builder.yml: `grep -A2 "notarize:" electron-builder.yml` — if it has nested fields, it's the old format.

### [Configuration] — 2026-04-30
- **MISTAKE**: Used `mac.identity: "Developer ID Application: Status Consulting Firm LLC (Z349CC556Z)"` (full cert name) in `electron-builder.yml`. Build failed with `Please remove prefix "Developer ID Application:" from the specified name`.
- **FIX**: Strip the prefix — `identity: "Status Consulting Firm LLC (Z349CC556Z)"`. electron-builder picks the right cert when both Apple Distribution and Developer ID Application certs exist for the same team. (Note: when calling `codesign` directly, this same name is *ambiguous* and you must use the SHA hash. Different tools, different conventions.)
- **CONTEXT**: electron-builder enforces this naming convention. The cert in Keychain shows the full name, which is misleading.
- **DETECTION**: Build error message mentions `remove prefix "Developer ID Application:"`. Grep: `grep "identity:" electron-builder.yml` — value should NOT start with "Developer ID Application:".

## Pre-populated rules — audit 2026-06-13

> Appended, not overwritten; only rules not already present above. These runtime/build gotchas were documented in the root `CLAUDE.md` but were missing from this lessons file. Each is a standing rule.

- **Never use null bytes (`\x00`) in `execFile` args** — Node throws `ERR_INVALID_ARG_VALUE`. Use a text separator like `||SEP||` instead (see `git-service.js` commit-log format).
- **Dev process name is `"Electron"`**, not the app name — use `tell process "Electron"` in AppleScript during dev. The display name only applies to packaged `.app` builds.
- **`build-and-install.sh` MUST `rm -rf` the old `.app` before `cp -R`** — asar overwrite issue. Do not "optimize" that step away.
- **All terminal tabs stay mounted (CSS `display:none`)** — unmounting a tab kills the xterm buffer + the underlying PTY.
- **Native modules need `electron-rebuild`** (`node-pty`, `better-sqlite3`) after any dependency change, or the app fails to load the native addon at launch.
- **Remove the `remote-debugging-port` switch before shipping** (it enables CDP for Playwright/testing). Not currently present in `main.js` — treat this as a pre-ship check, keep it absent in release builds.
- **`~/Library/Application Support/Dobius/config.json` is managed by `config-manager.js` — do NOT hand-edit.**
- **The working tree currently has a large in-flight dashboard feature uncommitted** (Costs/Prompts/Search/ChangeFeed + a file-change service). Review and branch deliberately before building over it; don't blow it away.

## Asana queue (Auto Mode) — 2026-06-14
- **Asana `/tasks` query cannot combine `project` + `assignee`.** Asana returns HTTP 400 "Must specify exactly one of project, tag, section, user task list, or assignee + workspace". `fetchNewTasks` in `electron/asana-queue.js` must query by **project only** (`?project=<gid>&completed_since=...&opt_fields=<incl. assignee>`) and filter to the lane assignee **client-side** (`t.assignee?.gid !== gid`). Reintroducing `&assignee=` in that URL silently breaks every Auto Mode poll.
- **Auto Mode runs in the INSTALLED app, not dev.** Any `electron/` change (e.g. the token fallback or the query fix) only takes effect after `./build-and-install.sh`. The installed app reads the Settings PAT via `asanaToken()` (`process.env.ASANA_PAT || getAsanaQueue().pat`) — a Finder-launched app has no env PAT, so the config `pat` fallback is required.
- **Verify the queue end-to-end via the bridge**, not just config: `POST http://127.0.0.1:8421/asana/fetch` with `{ "projectName": "<allowlisted name>" }` and the token from `userData/voice-bridge-token`. `ok:true` + non-empty `tasks[]` means detection works through the live app. `seen[]` in `config.asanaQueue.autoMode` filling to `MAX_TASKS_PER_TICK` (3) confirms a poll actually dispatched.

### [Architecture] — 2026-06-12
- **MISTAKE**: `work-registry.js` `rehydrate()` restored persisted items from `config.workRegistry.items` verbatim, including `status: 'running'`. A `running` item cannot survive a process restart (its PTY/tab is gone and rehydrate never recreates a watcher), so it sat `running` forever. The concurrency cap in `registerWork` counts running items (`running.length >= maxConcurrentAgents`, default 1), so a single phantom-running item from a prior session permanently blocked ALL new Conductor/iMessage work dispatch with `concurrency cap: 1/1 agents already running` for a tab that no longer existed.
- **FIX**: In `rehydrate()`, reconcile any persisted `status === 'running'` item to `'interrupted'` (stamp `completedAt`/`lastUpdate`/`finalReport`), then `persist()`. Do NOT fire a final-report iMessage on rehydrate (would spam on every launch) — it's a silent status fix. The cap then counts only genuinely-running (current-session) items.
- **CONTEXT**: Classic stale-persisted-state bug. Any state that means "a live process exists" (running/active/in-flight) must be reconciled on load, because the process it referred to died with the previous session. Applies to anything persisted that implies a live OS resource.
- **DETECTION**: `grep -n "status === 'running'" electron/work-registry.js` — rehydrate must reconcile, not just `items.set(e.workId, e)`. Verified via before/after ship-test in /tmp: a seeded `running` item blocked `registerWork` (ok:false) pre-fix, registered fine (ok:true) post-fix, while the cap still blocked a genuine second concurrent agent.

### [Build] — 2026-06-12
- **MISTAKE**: App crashed on launch with `Uncaught Exception: ReferenceError: completed is not defined` at `electron/voice-bridge.js:638`. The CLI helper scripts (`CLI_*_SCRIPT`) are authored as JS **template literals** (backtick strings). Line 638 was `STATUS="${3-completed}"` (bash default-value expansion). Inside a backtick string, JS parses `${3-completed}` as the interpolation `${3 - completed}`, evaluates it at module load, and `completed` is not a JS variable, so the whole main process throws before the app window can open.
- **FIX**: Escape the `$` so it stays literal bash: `STATUS="\${3-completed}"`. Any bash `${...}` brace-expansion inside these template-literal scripts MUST be backslash-escaped. The already-correct siblings (`\${1-}` line 696, `\${1-list}` line 802) show the intended pattern.
- **CONTEXT**: Bare `$1`, `$@`, `$#`, `$*` are safe (no brace, JS ignores them). Only `${...}` is dangerous because JS treats `{` as the start of an interpolation. This bites whenever you add a bash default/substitution to a CLI helper.
- **DETECTION**: `grep -nP '(?<!\\)\$\{[0-9@*#]|(?<!\\)\$\{[A-Za-z0-9_]+:?-' electron/*.js` — finds UNescaped bash brace-expansions inside JS strings. Every hit must have a preceding backslash.

### [Build] — 2026-06-12
- **MISTAKE**: After the v1.0.22 build (built 09:47), EVERY terminal tab opened blank and would not start; new sessions and `claude --resume` both came up empty. Root cause: electron-builder's asar-unpack step stripped the execute bit on node-pty's `spawn-helper` Mach-O binary (bundled at `app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper` as `-rw-r--r--` instead of `-rwxr-xr-x`). node-pty execs spawn-helper to launch the shell behind each PTY; with no +x the exec fails (EACCES), the pty opens but the shell never starts, so the tab is blank. Source `node_modules` copy was correct (0755) — only the packaged copy was broken, which is why it built fine and ran broken.
- **FIX**: Two parts. (1) Immediate: `chmod +x` the installed app's spawn-helper (no app restart needed — spawn-helper is exec'd fresh on each pty.spawn). (2) Permanent: added `build/after-pack.cjs` electron-builder `afterPack` hook that `chmod 0755`s spawn-helper after packing and before signing, so the signature seals the correct mode. Wired via `afterPack: build/after-pack.cjs` in `electron-builder.yml`. Hook throws if spawn-helper is missing (better to fail the build than ship blank terminals).
- **CONTEXT**: Applies after any `npm install` / `electron-rebuild` / version bump that triggers a fresh electron-builder pack. The bit can drop again on any rebuild without the afterPack guard. Known electron-builder + node-pty packaging interaction, not specific to one Electron version.
- **DETECTION**: `test -x "/Applications/Dobius+.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper" && echo OK || echo BROKEN` — run after every build. Also: `ls -la <that path>` should show `-rwxr-xr-x`.

### [Performance] — 2026-06-12
- **MISTAKE**: Clicking into the Dashboard crashed the MAIN process (EXC_BREAKPOINT/SIGTRAP, v1.0.22). Root cause: `DashboardView` mount calls `dataLoadAllSessions()` -> `loadAllSessions()`, which fanned `parseJsonl(file, 5)` across ALL ~/.claude transcript files at once (6,773 files, 927MB). `parseJsonl`'s `limit` arg did NOT limit reading: it `fs.readFile`'d the WHOLE file, `JSON.parse`'d every line, then sliced the last 5 at the very end. One 24MB transcript = +95MB parsed in memory; all of them concurrently = multiple GB = main-process heap OOM = V8 fatal. JS try/catch and uncaughtException handlers CANNOT catch a V8 heap-OOM abort, which is why it surfaced as a bare SIGTRAP crash report with no logged reason.
- **FIX**: (1) `parseJsonl` now reads only a bounded TAIL of the file when `limit > 0` (new `readTail()` reads backward in 64KB chunks, 4MB cap) instead of the whole file. Verified identical last-5/last-100 output vs the old full read, with +0MB vs +95MB memory on a 24MB file. (2) `loadAllSessions` flattens all files into one list and processes them through a new `mapLimit(items, 24, fn)` bounded worker pool instead of nested unbounded `Promise.all` (also prevents EMFILE from thousands of simultaneous opens). (3) Added `setupCrashLogging()` in main.js (uncaughtException/unhandledRejection/render-process-gone/child-process-gone -> userData/crash.log) so the NEXT failure leaves a readable reason. Honest limitation: native (node-pty/sqlite) aborts and V8 heap OOM still produce a system .ips and bypass the JS handlers; the real defense for those is not loading GB into memory (fix 1+2).
- **CONTEXT**: Any IPC handler in the main process that reads/parses unbounded amounts of `~/.claude` data is an OOM risk that grows as transcript history grows. A `limit` parameter is only real if it bounds the I/O, not just the returned slice.
- **DETECTION**: `grep -n "readFile" electron/data-utils.js` — any whole-file read feeding a `slice(-limit)` is the anti-pattern. Also: `du -sh ~/.claude/projects` (927MB at time of bug) shows how much the old loader tried to hold at once.

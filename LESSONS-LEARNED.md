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

### [Architecture] 2026-08-01 (tear-off PTY ownership on window close)
- **MISTAKE**: When fixing the tear-off audit, I gated a tear-off window's PTY kill on ownership read at the `'closed'` event (`getTerminalWebContentsId(id) === myWcId`). Codex proved that at `'closed'` the window's `webContents` is ALREADY destroyed, so the owner lookup returns `null`, `null === myWcId` is false, and normally-closed tear-offs SKIPPED their kill and leaked the PTY. A prior attempt reading ownership at `'close'` (webContents still alive) worked for user closes but `win.destroy()` (timeout/quit paths) skips `'close'` entirely, so that snapshot never ran.
- **FIX**: The correct predicate at `'closed'` is "kill iff NO live window still owns it": `if (getTerminalWebContentsId(tearOffTabId) === null) killTerminal(tearOffTabId)`. `getTerminalWebContentsId` returns `null` when the entry is gone OR `webContents.isDestroyed()`. This one check covers every case: normal close (owner destroyed, so null, so kill), aborted tear-off with the SOURCE window still open (source alive, non-null, spare it, so it never kills the source's live tab), and orphan (source also closed, null, kill). No `'close'` snapshot needed.
- **CONTEXT**: Electron destroys a window's `webContents` by the time the `'closed'` event fires (confirmed by Codex web-search of Electron 40 docs). Any close-time logic that needs to read the closing window's own `webContents` must run in `'close'` (still alive), NOT `'closed'`. But `win.destroy()` skips `'close'`, so logic that MUST run on every teardown (including destroy) belongs in `'closed'` and must not depend on the closing window's live webContents. Also: "owns" a cross-window PTY means `entry.webContents.id`, set on both `createTerminal` and `reassignTerminal` (claim). Registration-based ownership (a tear-off window is registered before it has CLAIMED) is wrong: an in-flight/unclaimed tear-off does not yet own the PTY, so keying `getTearOffTabIdsForProject` exclusion on it let the primary skip killing an unclaimed torn tab and orphan it.
- **DETECTION**: `grep -n "on('closed'" electron/window-manager.js` then check any `webContents` read inside a `'closed'` handler (it reads a destroyed object). For PTY ownership: `grep -n "getTerminalWebContentsId\|reassignTerminal" electron/*.js`.

### [Architecture] - 2026-09-03
- **MISTAKE**: v1.0.65 (`beb6191`) made `activeClaudeAccountId` a real pointer
  that sets `CLAUDE_CONFIG_DIR` per terminal, without noticing that Claude Code
  scopes session transcripts to the config dir. Users who had clicked the old
  cosmetic Switch button had a stale pointer that went LIVE on update, orphaning
  all session history. `claude --resume <id>` returned "No conversation found"
  for every session, while `electron/data-utils.js:7` (`CLAUDE_DIR` hardcoded to
  `~/.claude`) kept listing those same sessions in the Sessions tab and feeding
  them to auto-resume.
- **FIX**: Treat an account profile as a login boundary only. Symlink the shared
  setup from each profile into `~/.claude` (`electron/account-profile-share.js`),
  keeping only `.claude.json` per-profile. Call it at app start, at
  `accounts:initProfileDir`, at `accounts:activateClaude`, and critically at the
  terminal spawn choke point in `terminal:create` where `accountEnv` is built,
  which is the ONLY place that decides `CLAUDE_CONFIG_DIR`.
- **CONTEXT**: Whenever a feature changes which DIRECTORY a child process reads
  its state from, audit every other module that reads the same state by a
  hardcoded path. A split between "what the UI lists" and "what the CLI can
  open" presents to the user as data loss even though nothing was lost.
- **DETECTION**: `grep -rn "CLAUDE_CONFIG_DIR" electron/` and compare against
  `grep -n "CLAUDE_DIR\|PROJECTS_DIR" electron/data-utils.js`. If a spawn sets
  the config dir but a reader hardcodes `~/.claude`, they will disagree.

### [Process] - 2026-09-03
- **MISTAKE**: Wrote a filesystem migration whose guards used `path.resolve()`
  and assumed two different path strings meant two different directories. A
  profile dir that was a symlink into `~/.claude` would have had the real
  `projects` dir renamed aside and replaced by a self-referential symlink,
  making 3.9GB of transcripts unreachable with ELOOP.
- **FIX**: Guard every destructive fs operation with `fs.realpathSync` on both
  sides and bail when they resolve to the same inode. Pre-scan for collisions
  (`countCollisions`) so a directory migration is all-or-nothing rather than
  partially draining and leaving a split tree.
- **CONTEXT**: Applies to any code that moves, links, or deletes under a
  user-supplied or config-supplied path. Five Codex rounds were needed here and
  each one found a real High; the first three rounds all missed the ones the
  next round caught.
- **DETECTION**: `grep -n "renameSync\|symlinkSync\|rmdirSync\|rmSync" electron/*.js`
  then confirm each call site resolved its paths with `realpathSync` first.

### [Process] - 2026-09-03
- **MISTAKE**: Deleted a live session's transcript. After creating a test fork
  with `claude --resume <id> --fork-session`, I identified "the fork" as
  `ls -t *.jsonl | head -1` and deleted it. `ls -t` sorts by mtime, and the
  CURRENTLY RUNNING session is always the most recently written file, so the
  newest entry was the live session, not the fork. About 960KB of that
  session's on-disk history was destroyed. Not recoverable: Claude Code appends
  by path (it recreated an empty file immediately), no process held the deleted
  inode, there is no Time Machine destination, and the only APFS local
  snapshots are `com.apple.os.update-*`.
- **FIX**: Never identify a file to delete by recency. Identify it by CONTENT.
  For a fork, grep for the unique marker string the test prompt asked the model
  to emit, and explicitly exclude the source session id:
  `grep -l "MY_TEST_MARKER" *.jsonl` then skip the original. Also check
  `$CLAUDE_CODE_SESSION_ID` before deleting anything under `~/.claude/projects`,
  since that is the session doing the deleting.
- **CONTEXT**: Applies to any cleanup of generated artifacts while the
  generator is still running. The live process is always the freshest file.
- **DETECTION**: `grep -n "ls -t\|sort -rn\|head -1" ` in any script that
  then calls `rm`. Deleting whatever sorted first is the anti-pattern.

### [Build] - 2026-09-14
- **MISTAKE**: Added `asarUnpack:` to electron-builder.yml by string-replacing
  on the first two entries of `files:` and appending after them. YAML has no
  list terminator, so the remaining `files:` entries (`electron/**/*`,
  `node_modules/node-pty/**/*`, `package.json`) became members of `asarUnpack`
  and the package lost its entry point. The `--dir` build failed, and I did not
  notice because `npx electron-builder ... | tail -25` reports tail's exit code.
- **FIX**: Insert new top-level keys by anchoring on the NEXT top-level key
  (`\npublish:\n`), then parse the file (`yaml.safe_load`) and assert the lists
  you did not mean to touch. Never pipe a build into `tail` without
  `set -o pipefail` or writing to a log and echoing `$?` separately.
- **CONTEXT**: Any YAML/TOML config with lists; any background build whose
  success is judged by a truncated tail.
- **DETECTION**: `python3 -c "import yaml;d=yaml.safe_load(open('electron-builder.yml'));print(d['files'],d.get('asarUnpack'))"` and `grep -n "| tail" ` on build invocations.

### [Git] - 2026-09-14
- **MISTAKE**: Ran `git add -A` while a background packaged build was writing
  into `dist-shiptest/` in the working tree, staging a 168MB Electron
  Framework binary. Codex flagged it as a P1 before the push would have been
  rejected by GitHub's 100MB limit.
- **FIX**: Build outputs used for ship-tests live in a gitignored dir
  (`dist-shiptest` now is). Stage explicit paths, or run `git add -A` only
  when no build is in flight, and read `git diff --cached --name-only` before
  committing.
- **CONTEXT**: Any repo where ship-tests produce artifacts inside the tree.
- **DETECTION**: `git diff --cached --name-only | grep -E "^dist|\.app/"`

### [Architecture] - 2026-09-14
- **MISTAKE**: Wrapped `ipcMain.on` by registering a fresh closure and keeping
  a `WeakMap<originalFn, wrapper>` so `off()` could translate. That breaks
  EventEmitter's contract three ways: the same fn on two channels shares one
  map slot, a duplicate registration overwrites the slot so the older one can
  never be removed, and a pending `once(fn)` cannot be cancelled by `fn`
  (the map holds Node's internal once-wrapper, not `fn`).
- **FIX**: Do what EventEmitter does. Give the wrapper `.listener = fn`, and
  implement removal as a per-channel scan of `rawListeners(channel)` from
  newest to oldest matching `w === x || w.listener === x ||
  w.listener?.listener === x`. Test with the REAL `node:events` EventEmitter:
  on/off, on twice/off twice, once+emit x3, once+off+emit, `this` binding.
- **CONTEXT**: Any monkeypatch of an EventEmitter's `on`. Electron's ipcMain
  is one.
- **DETECTION**: `grep -n "WeakMap" electron/*.js` near any `.on =` override.

### [Architecture] - 2026-09-14
- **MISTAKE**: An event-loop drift watchdog treated a Mac going to sleep as a
  stall: an 8h nap logged "blocked ~28800s" AND consumed the 30s report
  budget, so a real 3s stall right after wake went unrecorded. A 10-minute
  plausibility cap did not fix the short-nap case, because powerMonitor's
  'resume' is delivered asynchronously and the first tick after wake can run
  before it.
- **FIX**: Set a `suspended` flag on 'suspend' (which always precedes the
  sleep), treat any tick while suspended, or any gap over the cap, as a clock
  jump: log it under the watchdog's own kind, reset the baseline, and never
  touch the report budget. Clear the flag on 'resume'.
- **CONTEXT**: Any timer-drift heuristic on a laptop.
- **DETECTION**: `grep -n "lastReportAt" electron/stall-watchdog.js` and
  confirm a clock-jump path returns before it is written.

### [Architecture] - 2026-09-14
- **MISTAKE**: Reasoned about merging a profile's plugins INTO the shared
  store (subset manifests, byte-identical collisions, "shared wins") without
  first checking that the shared store worked. It did not: its manifests
  pointed at a dead home directory and 15 caches were missing, so the
  "identical" files were marketplace clones and the "superset" manifest was a
  list of broken installs. The collision warning I was trying to silence was
  protecting the only account whose plugins loaded.
- **FIX**: Before designing a merge, run the consumer's own health check on
  BOTH sides (`claude plugin list` under each config dir) and read the
  literal paths in the manifests. A store that lists more is not a store that
  works. Then ask whether a documented mechanism already does the sharing
  (here `CLAUDE_CODE_PLUGIN_CACHE_DIR`) before building one.
- **CONTEXT**: Any "make X available everywhere" request over state that was
  migrated between machines or users.
- **DETECTION**: `grep -c "/Users/" ~/.claude/plugins/*.json` and compare
  against `$HOME`; `CLAUDE_CONFIG_DIR=<p> claude plugin list | grep -c failed`.

### [Architecture] - 2026-10-06
- **MISTAKE**: The mobile server's launch path was one `startMobileServer()` call with no retry and no log line. Tailscale assigns the 100.x address after login items start on a reboot, so the start answered "No Tailscale connection found", nothing tried again, and Sam's phone was dead until he opened Settings and flipped the switch (his task: "make sure the mobile server ALWAYS DEFAULTS TO ON"). The default was also `enabled: false`, so a fresh install started off.
- **FIX**: Anything that depends on a network interface or another app being up must retry on a timer until it succeeds or the user says stop, and must log the first failure. `electron/mobile-autostart.js` (createAutoStart: 5s for two minutes, then 30s, unref'd timer; createStartGate: one shared in-flight start, stop bumps a lifecycle so a start still awaiting MagicDNS discards itself). Default on. The Settings switch binds to the preference (`status.enabled`), never to `running`, or the user cannot turn off something that is retrying.
- **CONTEXT**: Codex found three pre-existing races the retry made likely: a stop during the DNS await could not cancel the start, Settings and the retry could build two servers on one port (the second listen rejected and a leaked heartbeat then read `wss.clients` on null), and `ws` re-emits the HTTP server's 'error' on the WebSocketServer where an unhandled 'error' throws out of emit before our own listener runs, so a busy port 8420 was an uncaught exception rather than a failed start.
- **DETECTION**: `grep -n "once('error'" electron/mobile-server.js` must be paired with a `wss.on('error'` listener; any `await` inside a start function must be followed by a `stillCurrent()` check before resources are created.

### [Deployment] - 2026-10-06
- **MISTAKE**: `./release.sh patch` bumped and pushed 1.0.77, then died inside electron-builder: notarytool HTTP 403 "A required agreement is missing or has expired". Apple had a new Developer Program License Agreement waiting for the account holder; nothing in the preflight checks for it, so the version bump landed on main with no release behind it.
- **FIX**: Only the account holder can fix it: sign in at developer.apple.com (and App Store Connect) as sahil.nihal09@gmail.com, accept the pending agreement, then re-run `./release.sh patch` (a fresh bump; the unreleased bump commit is harmless, its tag was never pushed). Before a release, `xcrun notarytool history --apple-id "$APPLE_ID" --team-id Z349CC556Z --password "$APPLE_APP_SPECIFIC_PASSWORD" | head -3` is a cheap probe: it fails with the same 403 when an agreement is pending.
- **CONTEXT**: v1.0.77 (mobile server auto-start). Users stayed on 1.0.76; the auto-updater saw nothing because no release was published.
- **DETECTION**: `grep -n "agreement" dist-electron/builder-debug.yml` after a failed build; `gh release view v<version>` says "release not found".


### [Architecture] - 2026-10-11
- **MISTAKE**: Added a startup "upgrade in place" that re-runs the managed Claude hook installer (`enableClaudeHooks` in `electron/main.js`) on launch. The installer's `stripStatusHooks` dropped any hook GROUP that contained a Dobius command, so a user command living in the same group (hand-merged, or added by another tool) would have been deleted from `~/.claude/settings.json` automatically, with no click. Codex rated it Critical.
- **FIX**: Strip at the COMMAND level: keep the group, filter out only commands carrying a Dobius marker, drop the group only if it is left empty. Anything that edits a shared config file must remove exactly what it owns.
- **CONTEXT**: A destructive path that was tolerable behind an explicit Settings click becomes dangerous the moment it runs automatically. Re-audit every helper an auto-run path calls.
- **DETECTION**: `grep -n "groups.filter\|isStatusGroup" electron/main.js`; any filter that removes a whole group because one member matches is the anti-pattern.

### UI/UX: 2026-10-20
- **MISTAKE**: The History hover card's rAF "follow the row" loop called `setHoverAnchor(rect)` in the same frame that a scroll handler had already called `setHoverAnchor(null)`. React had not committed the close and the effect cleanup had not cancelled the rAF yet, so the plain set reopened the card at the new position and it stayed stuck open (`src/components/Project/ConversationCard.jsx`). Found only by the ship-test, not by review.
- **FIX**: A background loop that only UPDATES an open overlay must use a functional update that keeps a closed state closed: `setHoverAnchor((prev) => (prev ? r : prev))`.
- **CONTEXT**: Any rAF/interval/observer that writes state an event handler can also clear. Effect cleanup runs after commit, so for one frame both writers are live.
- **DETECTION**: `grep -n "requestAnimationFrame" -A8 src/components`; a non-functional set inside a rAF loop next to a close path is the pattern.

### Security: 2026-10-20
- **MISTAKE**: `encodePathLikeClaude('..')` returned `'..'`, so every `path.join(PROJECTS_DIR, enc, id + '.jsonl')` with a renderer-supplied projectPath could escape to `~/.claude` (deleteSession, loadTranscript, lastAssistantMessage, context, hover). All three Codex lenses flagged it on the new hover IPC; it predated that IPC.
- **FIX**: `safeProjectSegment` in both encoders and in resolveTranscriptPath's stripped form: a dots-only segment gets a `-` prefix and can never name a real dir.
- **CONTEXT**: Validating the sessionId regex is not containment. The projectPath half of the join needs it too.
- **DETECTION**: `grep -n "path.join(PROJECTS_DIR, enc" electron/data-service.js`; each enc must come from an encoder that calls safeProjectSegment.

### Git: 2026-10-20
- **MISTAKE**: Used `git stash push <file>` then `git stash pop` to test old code. Pop restored the file's working-tree changes but not its STAGED state, so the index silently reverted to HEAD. A later `git show :<file>` "round-1 version" was really HEAD, and a regression test looked like it failed for the wrong reason.
- **FIX**: To run a test against an older version, copy the file aside (`cp f /scratch/f.cur`), write the old version in, run, copy back. Or `git stash pop --index`. Then check `git diff HEAD --stat`, not `git diff --stat`.
- **CONTEXT**: Matters whenever you prove a new test catches the old bug.
- **DETECTION**: `git diff HEAD --stat` after any stash dance; compare against what you expect changed.

### Testing: 2026-10-21
- **MISTAKE**: Harness teardown sent SIGTERM to the dev Electron on port 9224 and assumed it died. Two dev Electrons ignored it and kept running, so the next harness could not bind 9224 and the probe silently drove the OLD instance (its userData dir already deleted, its in-memory config still live), which looked like a new bug.
- **FIX**: After teardown, verify with `pgrep -fl "dobius-plus/node_modules/electron/dist"` (must print nothing) and `kill -9` those PIDs if needed. The pattern only matches the dev Electron in node_modules, never /Applications/Dobius+.app.
- **CONTEXT**: Any harness run. A probe that "fails" on state it did not create is talking to a stale instance.
- **DETECTION**: `pgrep -fl "dobius-plus/node_modules/electron/dist"`

### UI/UX: 2026-10-21
- **MISTAKE**: Every folder picker used `properties: ['openDirectory']` with no parent window. macOS then shows no New Folder button, so on a fresh Mac (only Desktop/Documents/Downloads) "New Project" had nothing sensible to pick; and the projects folder (settings.projectScanDir) was settable only from Settings inside a project window, which a fresh Mac cannot reach.
- **FIX**: `pickFolder(event, opts)` in electron/main.js: sheet on the sender window, `openDirectory` + `createDirectory`. The launcher has its own projects-folder button (IPC window:pickProjectsFolder) and an empty state offering both actions.
- **CONTEXT**: Test first-run flows with an empty HOME: `HOME=<scratch>/home DOBIUS_USERDATA_DIR=... npx electron --inspect=9239 .` and stub `dialog.showOpenDialog` over the main inspector (Runtime.evaluate with includeCommandLineAPI for `require`) so no native dialog steals Sam's focus.
- **DETECTION**: `grep -n "showOpenDialog" electron/*.js` (all should go through pickFolder)

### Git: 2026-10-26
- **MISTAKE**: Ran a ship-test probe with no arguments (`node probe.mjs`), so its `${OUT}/x.png` became `undefined/x.png` inside the repo; `git add -A` in the next commit shipped it (4535cb0, pushed with v1.0.81).
- **FIX**: Probe scripts must exit when their output arg is missing, and before any `git add -A` run `git status --short` and read every `??` line. Prefer `git add <paths>`.
- **CONTEXT**: Any scratchpad script that writes screenshots relative to a CLI arg.
- **DETECTION**: `git ls-files undefined/ && git status --short | grep '^??'`

### Testing: 2026-10-26
- **MISTAKE**: Seeded harness tabs without `projectPath`, so their PTYs spawned in `~` and main's tear-off guard (`getTerminalsForProject(projectPath).includes(tabId)`) refused every tear-off. It looked like the tear-off was broken.
- **FIX**: Seed tabs as `{ id, label, labelLockedByUser: true, projectPath: repo, kind: 'terminal' }`. This is also why "seeded tabs open in ~".
- **CONTEXT**: Any harness test of tear-off, dock, or per-project terminal logic.
- **DETECTION**: `grep -n "projectPath" <seed script>`

### Testing: 2026-10-28
- **MISTAKE**: Fixing Codex's "queued raw key skips stillOk after the gap", I also added `!it.stillOk()` to the delayed Enter in `electron/chat-service.js` drainSubmits. That broke chat-service test 4, which pins the opposite rule on purpose: a paste that already went out must get its Enter even if the phone that sent it dropped, or its text sits half-typed and gets glued onto the next message.
- **FIX**: Gate the paste and raw keys on stillOk. Never gate the Enter of a paste that already went out (comment at the check says why).
- **CONTEXT**: Any change to the submit queue guards. Read the test names before adding a guard: several encode deliberate asymmetries.
- **DETECTION**: `node --import ./electron/__tests__/chat-service-register.mjs ./electron/__tests__/chat-service.test.mjs`

### Process: 2026-10-28
- **MISTAKE**: Ran three Codex lenses in parallel with no fallback plan. The only Codex login on this Mac (`~/.codex/auth.json`, promax) hit its usage limit mid-run; two lenses died with "You've hit your usage limit" and the output files still looked like normal runs until the tail was read.
- **FIX**: Read each lens output's TAIL for `ERROR: You've hit your usage limit` before treating a lens as clean. When Codex is out, run the unfinished lenses with independent Claude reviewers (same brief file) and record in the commit that Codex still owes the pass before release.
- **CONTEXT**: Every Codex bugbot round. `~/.codex-profiles` does not exist here, so there is no second login to switch to.
- **DETECTION**: `grep -l "usage limit" <scratchpad>/codex-chat/*.out`

### Testing: 2026-10-28
- **MISTAKE**: Added a test to `electron/__tests__/selector-parser.test.mjs` that imported `selectorFingerprint` from `../chat-service.js`. It passed when run with `--import ./electron/__tests__/register.mjs`, but `npm test` runs that suite BARE (`test:selector`), and chat-service pulls in terminal-manager -> config-manager -> `electron`, so the whole gate failed with "does not provide an export named 'app'".
- **FIX**: Keep pure helpers in the pure module (`selectorFingerprint` now lives in selector-parser.js, re-exported by chat-service). Always confirm with `npm test`, not just the single suite with a stub loader.
- **CONTEXT**: Which suites get the electron stub is decided per script in package.json, not by the test file.
- **DETECTION**: `grep -n "test:selector\|test:chat" package.json` and check the imports of a bare-run suite for anything that reaches `electron`.

### UI/UX: 2026-10-28
- **MISTAKE**: The phone selector card kept its answer token in a ref (`selTokenRef`) that the WS handler overwrote the moment a new prompt arrived, while React had not yet rendered the new card. A tap on the still-visible card A was sent with prompt B's valid token and would have approved a command the user never saw (Codex round 9, Critical, three lenses).
- **FIX**: Keep the token ON the state object that renders the card (`selector.token`) and have each button pass the card it was rendered with (`chooseOption(selector, n)`). A result updates the token only if the card on screen is still the one tapped.
- **CONTEXT**: Any value that authorizes an action on what is DISPLAYED must travel with the render, never in a ref written ahead of it. Desktop ChatPane already did this; the phone port did not.
- **DETECTION**: `grep -n "Ref.current = .*token\|TokenRef" mobile/*.jsx src/components/**/*.jsx`

### Process: 2026-10-28
- **MISTAKE**: Waited for this session's Codex lenses with `until [ $(pgrep -f "codex exec ...") -eq 0 ]`. Other Claude sessions on the machine run `codex exec` too, so the loop never ended after this session's four lenses had finished.
- **FIX**: Have each lens write a done marker (`...; echo done > rN-lX.done`) and wait on those files.
- **CONTEXT**: Every parallel Codex run on this Mac; several projects' sessions run Codex at once.
- **DETECTION**: `grep -rn "pgrep -f \"codex exec" <scratchpad>`

### Architecture: 2026-10-28
- **MISTAKE**: To keep a 64KB replay tail from starting inside an escape sequence, `activityForTab` (electron/chat-service.js) first skipped FORWARD to the next ESC. That ESC was the `\x1b[0m` AFTER the spinner text, so the spinner itself was dropped. The first version of the test also put the cut in the filler, not in the escape, so it passed against the broken code.
- **FIX**: Back the cut up to the ESC that starts the sequence (`raw.lastIndexOf('\x1b', start)` within 512 chars). Assert the test geometry itself (`raw.slice(-65536).slice(0,3) === '31m'`) before asserting the behaviour, then sabotage the guard to confirm the test fails without it.
- **CONTEXT**: Any "start at a safe boundary" fix on a byte tail. Skipping forward discards real content; backing up only replays a little more.
- **DETECTION**: `grep -n "indexOf('\\\\x1b')" electron/*.js`

### Git: 2026-10-28
- **MISTAKE**: Ran `git stash -q && npx eslint ...; git stash pop` to compare lint against HEAD while new files were marked intent-to-add (`git add -N`). `git stash` FAILED on the intent-to-add entries ("not uptodate. Cannot merge"), so it created nothing, and the unconditional `git stash pop` then tried to pop an OLD, unrelated stash (`pre-release-untracked-ios`). It refused only because those untracked iOS files already existed.
- **FIX**: Never stash to get a baseline. Lint or test the HEAD version directly: `git show HEAD:<file> | npx eslint --stdin --stdin-filename <file>`. If a stash is ever unavoidable, chain the pop on the stash's success and check `git stash list` first.
- **CONTEXT**: The repo carries old stashes, so a pop after a failed push silently targets someone else's work. `git add -N` (used to put new files in `git diff` for Codex) is what makes stash fail.
- **DETECTION**: `git stash list` before and after; grep scripts for `git stash.*;.*git stash pop`

### Security: 2026-10-28
- **MISTAKE**: Built the error reporter's privacy layer (`electron/error-reporter.js` scrub) as a blocklist over free-text error messages: pair the quotes, strip paths, match secret shapes. Codex Bugbot broke it in every one of 18 rounds (nested V8 JSON quotes, escapes, apostrophes in names, truncation, a secret pass swallowing a quote, a cookie header erased by the quote span, home paths eating `: password=`), and each fix created the next hole.
- **FIX**: For free text, prefer rules that are safe BY CONSTRUCTION over parsers: one span from the first quote character to the last (to the end if odd or truncated) instead of pairing; replace a credential's content but KEEP its quote characters so later passes see the same boundaries; set aside "safe" tokens only when nothing else could be their edge. Order passes so no pass can destroy context another needs (credentials before quotes; paths last). Decide the residual policy up front (what is accepted, where the data goes) and state it in the code, or the review loop never converges.
- **CONTEXT**: Anything that uploads logs leaves the machine. Here it goes to a private org repo via the user's own gh login, which is why file names and single code words are accepted residuals.
- **DETECTION**: `grep -n "redactQuotes\|ACCEPTED" electron/error-reporter.js`

### Architecture - 2026-10-29
- **MISTAKE**: The phone question card re-joined Claude's wrapped rows by guessing from the WORDS at each break (`/` in a word, a dot before an extension, a trailing dot then lowercase, all-caps extensions...). Codex broke it nine rounds running (`Quarterly Rep`+`ort.pdf`, `Report.`+`PDF`, `backup.`+`SQLITE3`, then `echo cleanup`+`rm -rf build` joined into one command, hiding a delete). A hand-written wide-character table and a frame-rule check against nearby rows lost the same way (U+2329, CJK, U+1160, LRM on a space).
- **FIX**: Decide by WIDTH, measured by the terminal emulator itself. Claude's TUI only breaks a row at a space when the next word would not fit, so a row is a wrap only if it ends within 10 columns of the frame edge AND its successor's first word could not have fit; everything else keeps its break. `electron/screen-render.js` reports each row's true end column (`ends`) and first-word width (`firstWords`) from the cells; a cell is blank by its BASE character. The frame's rule must be as wide as the whole screen's widest row. Separators (blank, rule, glyph-only rows) are hard breaks, never paragraph splits (a split hid prompt rows: security review).
- **CONTEXT**: Any time a display re-derives structure the source already knows (widths, wraps), ask the source (the emulator) instead of re-guessing from text. A heuristic that needs a new clause every review round is the wrong model, not an incomplete one.
- **DETECTION**: `grep -n "rowWidth(" electron/selector-parser.js` (production paths must go through colOf/firstWordOf; rowWidth is the plain-array fallback only)

### Security - 2026-10-29
- **MISTAKE**: The strict Host rule for `/pair` lived in an `expApp.use` middleware keyed on `req.path === '/pair'` (`electron/mobile-server.js`). Express routing is case-insensitive and ignores a trailing slash by default, so `POST /PAIR` or `/pair/` reached the pair handler with the loose check (caught by the automated security review, not by Codex or me).
- **FIX**: Put a route-specific guard INSIDE the matched handler (`expApp.post('/pair', ...)` first line), never in a middleware that string-compares `req.path`.
- **CONTEXT**: Any per-route policy (auth, Host strictness, rate limit) applied by path comparison in middleware has the same bypass.
- **DETECTION**: `grep -n "req.path ===" electron/*.js`

### Process - 2026-10-29
- **MISTAKE**: A probe loop `for path in /pair /PAIR; do curl ...` in zsh overwrote `PATH` (zsh ties the lowercase `path` array to it), so curl, rm and the harness teardown all failed with "command not found".
- **FIX**: Never name a zsh variable `path` (also avoid `cdpath`, `fpath`, `manpath`). Use `u` or `route`.
- **CONTEXT**: Bash tool commands run under zsh here.
- **DETECTION**: `grep -nE "for path in|\bpath=" scratchpad/**/*.sh`

### Architecture - 2026-10-30
- **MISTAKE**: Assumed Claude Code's prompt in a Dobius tab is always the same kind of screen. It is not: with `"tui": "fullscreen"` (Sam's settings, or the `tengu_pewter_brook` rollout when unset) Claude runs in the ALTERNATE buffer with mouse tracking on and handles click, drag-select, Backspace-over-selection and copy itself; the default renderer draws in the NORMAL buffer with no mouse support at all, which is what Brett sees. A probe that runs plain `claude` on Sam's Mac tests the wrong renderer.
- **FIX**: Probe both with `claude --settings '{"tui":"default"}'` and `'{"tui":"fullscreen"}'`. Anything that edits Claude's prompt from Dobius (src/lib/prompt-edit-term.js) stands down unless `buffer.active.type === 'normal'` and `term.modes.mouseTrackingMode === 'none'`.
- **CONTEXT**: Any terminal-side feature that reads or drives Claude's TUI.
- **DETECTION**: `grep -n "mouseTrackingMode" src/lib/*.js src/hooks/*.js`

### Architecture - 2026-10-30
- **MISTAKE**: The prompt-box reader treated only `''` and `' '` as blank, so it never recognised Claude's prompt row: Claude draws `❯` followed by U+00A0 (no-break space), not a space. Every gesture silently did nothing in the first live run while all unit tests passed.
- **FIX**: Blank = `''`, `' '` or `' '` (src/lib/prompt-edit.js), with a test pinned to the real bytes. Dump the real cells (`getChars()` code points per cell) before writing a screen parser's fixtures.
- **CONTEXT**: Also: xterm 6 (unicode v6 widths) draws an emoji one cell wide where Claude counts two, so a prompt containing emoji is already drawn out of step with Claude's caret. The prompt editor refuses such prompts.
- **DETECTION**: `grep -n "u00a0" src/lib/prompt-edit.js`

### Testing - 2026-10-30
- **MISTAKE**: Edited src/hooks/useTerminal.js while a harness tab ran a real `claude`; Vite HMR remounted TerminalPane, which kills the tab's PTY and the claude in it, and the next probe drove a bare shell.
- **FIX**: After any edit under src/hooks or src/lib that TerminalPane imports, reload the harness page and start claude again before probing (`p10-reload.mjs` pattern: reload, then type the claude command).
- **CONTEXT**: Every harness ship-test of terminal behaviour.
- **DETECTION**: `pgrep -fl 'claude --settings'` returns nothing after an HMR update.

### Process - 2026-10-30
- **MISTAKE**: Harness teardown killed the CDP listener PID read once, then removed the userData and released the shared harness lock. A second Electron main from the same `npm run electron:dev` (concurrently parent still alive) was still listening on the CDP port, and another agent's Vite took 5173 seconds later while it was up.
- **FIX**: Kill the `concurrently` parent of YOUR worktree too (`ps aux | grep "[<worktree-name>]/node_modules/.bin/concurrently"`), then re-run `lsof -nP -iTCP:<cdp> -sTCP:LISTEN` AND confirm zero processes from your worktree path BEFORE `rm -rf <ud>` and releasing the lock.
- **CONTEXT**: Shared-lock harness runs with several agents on one machine (Brett batch, 1.0.88).
- **DETECTION**: `ps aux | grep "[d]obius-plus-<branch>" | grep -v codex`

### Security - 2026-10-30
- **MISTAKE**: A free-form `DOBIUS_CLAUDE_HOME=<path>` for redirecting an isolated instance's settings.json writes was aliased back onto the real `~/.claude` in three Codex rounds (symlink, different case on a case-insensitive volume, `..` through a symlink, a dangling link).
- **FIX**: Make it a switch (`DOBIUS_CLAUDE_HOME=1`) that places the throwaway home at `<DOBIUS_USERDATA_DIR>/claude-home`, the one place that cannot be the real home, and re-check by dev+inode before each write.
- **CONTEXT**: Any harness redirect of a write away from a shared real file. Do not accept a path when a fixed location inside the harness's own scratch works.
- **DETECTION**: `grep -n "DOBIUS_CLAUDE_HOME" electron/main.js`

- **MISTAKE**: In /openTab's `tabAlive` (electron/bridge-open-main.js) I wrote `!(getWindowEntryByWcId(id)?.closing ?? true)` to mean "a window exists and is not closing". A window entry whose `closing` is simply unset gives `undefined ?? true` = true, so every live tab read as dead and the harness dropped from 36/36 to 16/36. Three Codex lenses had just answered "No bugs found." on that exact line; only the ship-test caught it.
- **FIX**: Spell the two conditions out: `const win = getWindowEntryByWcId(...); return !!win && !win.closing`. `?? default` on an optional-chained boolean conflates "no object" with "property unset".
- **CONTEXT**: Any guard that combines "exists" and "flag not set" on a value whose flag is only ever set to true (window-manager sets `closing = true`, never false). Re-run the harness after every guard change, even one Codex cleared.
- **DETECTION**: `grep -n "?\.[a-zA-Z]* ?? true" electron/*.js src -r`

### Architecture - 2026-10-30 (2.0.0 integration)
- **MISTAKE**: Five features built on separate branches each read Claude's screen and the tab's input their own way, and only met on release/2.0.0. /openTab found Claude's input box as the LOWEST rule/❯/rule match, so a chained statusLine drawing a box under the prompt (possible once the model line kept the user's status output) and a numbered card ("1. Review README") both fooled it; and it counted keys only at terminal:write, while prompt editing holds a person's input in its own queue behind an image paste.
- **FIX**: The input box is the one holding the terminal CURSOR right of the ❯ (screen-render reports `modes.cursor`; prompt-edit's promptFrame already worked this way). Input a renderer holds back is reported to main the moment it is accepted (`terminal:inputHeld`), not when it drains.
- **CONTEXT**: Any new reader of Claude's screen or of a tab's input. A selector ALSO parks the cursor on its ❯ row, at column 0 or 1, so the caret test needs the column too, not just the row.
- **DETECTION**: `grep -rn "promptBoxText\|promptFrame\|terminal:inputHeld" electron src --include=*.js`

### Architecture - 2026-10-30 (2.0.0 follow-ups, left as is)
- **MISTAKE**: Not a mistake yet, deliberately deferred: two window-readiness signals (window:tabsReady for docks and /openTab, store tabsReady/markTabsReady for New Tab requests) and several window-focus helpers (bringToFront in bridge-open-main.js, focus paths in window-manager.js and main.js) do overlapping jobs. Selector-parser.js, prompt-edit.js and bridge-open-tab.js each define their own prompt/rule constants.
- **FIX**: Follow-up after 2.0.0: one readiness signal per window, one bring-to-front helper, and one module for Claude's prompt/rule shapes. Only what the integration fixes needed was shared (the caret rule, the bridge-opened first tab).
- **CONTEXT**: Integration review of release/2.0.0; judged too risky to unify this late.
- **DETECTION**: `grep -rn "tabsReady\|bringToFront\|RULE_RE\|PROMPT_ROW_RE" electron src`
### API - 2026-10-30
- **MISTAKE**: `electron/mobile-server.js` handled `authorizeTab` / `input` / `submitPrompt` with a bare `break` on any bad request (unknown tab id, unauthorized, oversized). The orchestrator client could not tell delivered from dropped and printed SENT for an afternoon of relays to short ids that never arrived.
- **FIX**: every write request is answered (`electron/mobile-tab-ops.js`): `ack` after the PTY write, `opError` with a code otherwise, and `uncertain: true` when the text may have landed anyway. Refusals use type `opError`, never `error`: the phone's Board alerts on every `error` frame. Docs: `docs/mobile-ws-protocol.md`.
- **CONTEXT**: Five Codex rounds were almost all about classifying outcomes as sent / not sent / unknown. Anything after the paste that is not a proven erase is unknown; a cancel must be written before its counters move; a replaced PTY's counters prove nothing. Never put an `await` between a queue's drain loop ending and its cleanup: a caller resumed in that microtask queues onto a queue that is then deleted.
- **DETECTION**: `grep -n "break; *//\|) break;" electron/mobile-server.js` for silent drops in new WS handlers; `npm run test:tabops`.

### Architecture - 2026-10-30 (2.0.0 accepted residual: holds are for /openTab only)
- **MISTAKE**: Starting from one real bug (the bridge could not see input prompt editing holds), I extended hold state to order Chat and command-bar sends too. Seventeen Codex rounds followed, each fix adding machinery (a held wait in chat-service, prompt-only pastes, drop generations, send ids, end and cut marks, tombstones) that the next round broke. chat-service.js went from 267 to 563 lines, and every Chat send goes through it. Round counts going up with machinery going up is the signal to stop, not to fix the next finding.
- **FIX**: Cut back (coordinator decision; the long version is kept on `release/2.0.0-heavy`). prompt-edit-term reports holds per tab and window; `/openTab` is the ONLY consumer and treats a held tab as someone typing. Chat keeps chat-service's own serialized queue, and the command bar writes directly.
- **CONTEXT**: Accepted residual: while prompt editing holds input (an image still saving, an edit running, normally well under a second), a Chat or command-bar send can land ahead of it. Worst case the text order in the prompt is swapped, or a pending image path lands after the message was sent. `/openTab` can never press Enter over held input. Do not build ordering for this. When a review loop stops converging, weigh the bug against the code it takes before fixing the next finding.
- **DETECTION**: `grep -rn "terminal:inputHeld\|heldInput" electron src` should show only bridge-open-main.js, preload.js and useTerminal.js; `wc -l electron/chat-service.js` should stay near 340.

### Architecture - 2026-10-30 (2.0.0: a bare claude's own record)
- **MISTAKE**: Tab-to-session linking guessed from process start time against transcript birth for years (`resolveFreshSessionId`), and declined whenever two unlinked bare claudes shared a project. New Tab now auto-starts Claude, so that is the normal case: one idle tab stopped every other tab in the project from linking, so History had no tab name, Chat stayed stuck and auto-resume could not restore it. The exact answer was on disk the whole time: `<configDir>/sessions/<pid>.json`, already read for the Waiting status.
- **FIX**: `presenceSessionId` (claude-presence.js) is consulted first in `resolveFreshSessionsForTabs`. Pid and start time must match, the id must be a UUID, and the transcript must exist in the project. A tab with a valid record is settled there, link or no link: it is no rival for timing and never falls to it. Links made this way are tagged `presence` and pass auto-resume's gate. Timing remains only for Claude versions without the file. Verified on 2.1.314 with a throwaway config dir, a dummy key and a real `claude`: the record's sessionId changes on `/clear`, so the `sessionMovedPast` workaround applies only to timing matches.
- **CONTEXT**: `claude --resume A` followed by `/clear` still reports A: argv wins for those tabs and the record is not consulted there. Not changed. Any new heuristic about Claude's state: look in that record first.
- **DETECTION**: `grep -n "presenceSessionId\|provenTabs" electron/*.js`; `npm run test:presence`.

### Architecture - 2026-10-30 (2.0.0: /openTab read its own echo as a dialog)
- **MISTAKE**: `promptBoxText` refused any screen with "Do you want to" above the input box. Claude echoes a submitted card above its box, so the card "Do you want to schedule a call tomorrow?" sent fine and was reported `submitted:false`, still in the prompt.
- **FIX**: With the caret in the box, rows above it are transcript and are not checked. A real dialog replaces the input box, so its caret is never in one. With no cursor position the old check stands. Below the box the footer and selector checks stand.
- **CONTEXT**: Text matching on anything above the prompt is matching the user's own words.
- **DETECTION**: `grep -n "dialogOnScreen" electron/bridge-open-tab.js`

### Performance - 2026-10-31 (2.0.0: idle CPU from the Tabs sidebar)
- **MISTAKE**: `data:getAllProjectTabs` polls every 5s per window and called `loadAllSessions`, which parsed the tail of every transcript on every call: 8s of wall clock and 9s of CPU with 10,300 files, about 130% of a core at idle.
- **FIX**: `transcriptCache` in data-service.js keeps what a tail told it, per file, while size and mtime hold. Clock, settings and caller choices (status, age, project names, hidden paths, excludeAutomated) stay outside it. `getAllProjectTabs` shares one session load in flight and for 3s; its rows are built per caller. Runs 1 and 2 went from 7.5s to under 0.2s, and rss fell.
- **CONTEXT**: The cache walks every file on every scan, so a least-recently-used cap would miss on every scan: past the cap it stops adding. Only a full scan may evict, since a scoped scan sees one project. parseJsonl answers [] on ANY error, so a tail that parsed to nothing is never cached. Strings in it must be detached (`detached()`): a slice keeps its parent alive for the life of the cache.
- **DETECTION**: `npm run test:sessioncache`; `grep -n "transcriptCache\|sharedAllSessions" electron/data-service.js`

### Testing - 2026-10-31 (a stand-in that agrees with you proves nothing)
- **MISTAKE**: My stand-in claude wrote `procStart` from local `ps`, so the ship-test passed while every real record was rejected on this Mac: Claude writes that field under TZ=UTC with no zone. The sidebar's Waiting status had the same bug from the day it shipped and never showed outside UTC. The same harness also inherited `CLAUDE_CONFIG_DIR` from the session that launched it, so one run wrote a stand-in record into a real profile's sessions dir (removed when the stand-in stopped; nothing else landed there). Codex caught the zone by reading the binary, not by reading the diff.
- **FIX**: Parse `procStart` as UTC. Before trusting a fixture or stand-in for a third-party file format, compare it with a REAL file on this machine: `scratchpad/.../real-check.mjs` read 22 live records and accepted all 22. A harness with a throwaway HOME must also `unset CLAUDE_CONFIG_DIR CODEX_HOME`.
- **CONTEXT**: Any stand-in that writes a format the real program owns. Any harness launched from inside a Claude session.
- **DETECTION**: `grep -n "procStart" electron/claude-presence.js`; `env | grep -E "CLAUDE_CONFIG_DIR|CODEX_HOME"` before launching a harness.

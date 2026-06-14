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

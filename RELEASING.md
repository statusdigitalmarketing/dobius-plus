# Releasing Dobius+

How to ship a signed, notarized, auto-updating release of Dobius+ to users.

## Architecture (one-time read)

- **Code signing** uses the `Developer ID Application: Status Consulting Firm LLC` certificate (already in this Mac's Keychain). Identity hash: `E95B5A61D673D466CCDA22615C9BF0F061BB9F2B`. Team ID: `Z349CC556Z`.
- **Notarization** uses Apple's `notarytool` against `sahil.nihal09@gmail.com` (the Apple Developer account holder for Status Consulting Firm LLC).
- **Auto-update** uses [`electron-updater`](https://www.electron.build/auto-update) pointed at GitHub Releases for `statusdigitalmarketing/dobius-plus`. The app checks 30s after launch and every 4 hours after that.
- **Hardened runtime + entitlements** are in `build/entitlements.mac.plist`. Required for notarization. The entitlements allow JIT (V8), unsigned executable memory, and library validation skip (for the `node-pty` native module).
- **DMG container signing is currently manual** — `electron-builder` v26 signs the .app inside but not the DMG wrapping it. See "Step 4" below.
- **Artifact filenames must use `${name}` not `${productName}`** — `latest-mac.yml` writes URLs using `${name}` (`dobius-plus`), but the default `artifactName` uses `${productName}` (`Dobius+`). They never match, so auto-update downloads 404. Fixed by pinning `mac.artifactName: ${name}-${version}-${arch}-mac.${ext}` and `dmg.artifactName: ${name}-${version}.${ext}` in `electron-builder.yml`. Don't change those without verifying the YAML still matches the actual files.

## One-time setup

Add to `~/.zshrc` and `source` it:

```bash
# Apple notarization
export APPLE_ID="sahil.nihal09@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # generate at https://account.apple.com (Sign-In and Security -> App-Specific Passwords)
export APPLE_TEAM_ID="Z349CC556Z"

# GitHub release publishing (token needs repo scope)
export GH_TOKEN="ghp_..."   # generate at https://github.com/settings/tokens
```

The Apple ID and team ID are not secret — only the app-specific password is. If it ever leaks (ends up in chat / a commit / a screenshot), revoke it at https://account.apple.com and generate a new one.

## Releasing a new version

### 1. Bump the version

```bash
npm version patch    # 1.0.1 -> 1.0.2 (bugfix)
npm version minor    # 1.0.1 -> 1.1.0 (new feature)
npm version major    # 1.0.1 -> 2.0.0 (breaking)
```

This updates `package.json`, creates a git tag, and commits the bump.

### 1b. PUSH main FIRST, before you build

```bash
git push origin main
```

> **Do this before step 2 or the release tag will point at the WRONG COMMIT.**
>
> electron-builder does not push your local tag. It asks GitHub to create the
> release, and GitHub creates the tag at whatever `main` is **on the remote** at
> that moment. If your new commits are still local, GitHub happily tags the
> PREVIOUS version's commit and the release then advertises source that does not
> match its own binaries.
>
> This bit v1.0.39: main was merged and tagged locally, the build ran, and the
> remote tag landed on `5b9d07e`, the v1.0.38 commit. The artifacts were fine
> (they are built from the local tree) and auto-update was unaffected, but
> checking out `v1.0.39` or downloading its "Source code (zip)" gave v1.0.38.
> Fixed after the fact with `git push origin --force refs/tags/v1.0.39`, which is
> a public-history rewrite and worth not needing.
>
> Push main first and the tag lands where it should. Step 5 then only has to push
> the tag itself.

### 2. Build, sign, notarize, and publish to GitHub

```bash
npm run electron:build -- --publish always
```

This single command will:
1. Run `vite build` to produce the renderer bundle
2. Run `electron-builder --mac` to package the .app
3. Sign the .app with the Developer ID cert
4. Submit the .app to Apple's notary service and wait (~5–10 min)
5. Staple the notarization ticket to the .app
6. Build `dobius-plus-x.y.z-arm64.dmg`, `dobius-plus-x.y.z-arm64-mac.zip`, and `latest-mac.yml` (artifact names per electron-builder.yml `artifactName: ${name}-${version}-${arch}-mac.${ext}`)
7. Upload all three to GitHub and **PUBLISH the release immediately**

If something fails before step 7, fix the issue and re-run. `electron-builder` will skip steps that already completed.

> **The release goes LIVE the moment this command finishes.** `electron-builder.yml`
> sets `publish.releaseType: release`, not `draft`. This doc used to say "draft",
> which was wrong, and it made steps 3 and 4 below read as though they happen
> before users can see anything. They do not.
>
> What that means in practice:
> - **Auto-update is safe.** It downloads the .zip, which electron-builder signed
>   and notarized in step 2. It is correct the instant it lands.
> - **The .dmg is briefly unsigned.** Step 3 below signs the DMG container, so
>   between this command finishing and step 3 completing (about 3 min), anyone
>   downloading the DMG by hand gets a Gatekeeper warning.
>
> Run steps 3 and 4 immediately, and do not announce a release until they are
> done. To close the window entirely, set `releaseType: draft` in
> `electron-builder.yml` and publish by hand at step 4, at the cost of a release
> that reaches nobody if you forget to publish it.

### 3. Sign + notarize the DMG container (manual, ~3 min)

`electron-builder` v26 doesn't sign the DMG file itself. Without this step, double-clicking the DMG triggers a Gatekeeper warning even though the .app inside is fully notarized. Until automated:

```bash
cd dist-electron

# Sign the DMG
codesign --sign E95B5A61D673D466CCDA22615C9BF0F061BB9F2B \
  --timestamp \
  "dobius-plus-$(node -p "require('../package.json').version").dmg"

# Notarize and staple
xcrun notarytool submit "dobius-plus-$(node -p "require('../package.json').version").dmg" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait

xcrun stapler staple "dobius-plus-$(node -p "require('../package.json').version").dmg"

# Verify
spctl -a -vvv -t install "dobius-plus-$(node -p "require('../package.json').version").dmg"
# Expected: "accepted, source=Notarized Developer ID"
```

**Stapling changes the DMG, so `latest-mac.yml` is now stale for it.** The manifest
was written during step 2, before the DMG was signed and stapled, so its recorded
`size` and `sha512` for the .dmg entry describe the pre-staple file (v1.0.39: the
manifest said 127424931 bytes, the real file was 127436606). Auto-update itself is
NOT affected, because `path:` points at the .zip and the .zip is never re-signed
here, but leaving a wrong hash in a published manifest is a trap. Every release
from v1.0.30 to v1.0.38 shipped with this mismatch.

Regenerate the DMG entry before uploading the manifest:

```bash
cd dist-electron
V=$(node -p "require('../package.json').version")
node -e '
const fs=require("fs"), cp=require("child_process");
const v=process.argv[1], dmg=`dobius-plus-${v}.dmg`;
const size=fs.statSync(dmg).size;
const hash=cp.execSync(`openssl dgst -sha512 -binary "${dmg}" | openssl base64 -A`).toString().trim();
let y=fs.readFileSync("latest-mac.yml","utf8");
const out=y.replace(new RegExp(`(  - url: ${dmg.replace(/\./g,"\\.")}\\n    sha512: )[^\\n]+(\\n    size: )\\d+`), `$1${hash}$2${size}`);
if(out===y){console.error("PATCH FAILED: dmg entry not matched");process.exit(1);}
fs.writeFileSync("latest-mac.yml",out);
console.log("patched dmg entry -> size="+size);
' "$V"
gh release upload "v$V" latest-mac.yml --clobber
```

Then re-upload the now-signed DMG to the GitHub release (it overwrites the unsigned one):

```bash
gh release upload "v$(node -p "require('./package.json').version")" \
  "dist-electron/dobius-plus-$(node -p "require('./package.json').version").dmg" \
  --clobber
```

### 4. Confirm the release is published

With the current `releaseType: release`, step 2 already published it, so this is a
verification, not an action:

```bash
V=$(node -p "require('./package.json').version")
gh release view "v$V" --json isDraft,isPrerelease,assets \
  --jq '"draft=\(.isDraft) prerelease=\(.isPrerelease) assets=\([.assets[].name]|join(", "))"'
```

Expect `draft=false prerelease=false` and all five assets (.zip, .zip.blockmap,
.dmg, .dmg.blockmap, latest-mac.yml). If you switched to `releaseType: draft`,
publish it here instead:

```bash
gh release edit "v$V" --draft=false
```

**Important:** `electron-updater` ignores draft releases. The release must be marked Published for users to receive the update.

### 5. Push the tag + commit

```bash
git push origin main --tags
```

## What users see

Once you publish, every user running a prior version will:

1. Within 30 seconds of next app launch (or within 4 hours if already running), the app checks GitHub Releases.
2. Detects the new version, downloads it in the background.
3. Shows a native macOS notification: *"Dobius+ x.y.z ready"*.
4. Shows an in-app banner (bottom-right) with a **Restart** button.
5. Click Restart -> app relaunches on the new version.

If they never click Restart, the update installs automatically the next time they fully quit and reopen the app.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `notarytool` returns `Invalid: ...code signature could not be verified` | Hardened runtime missing or wrong entitlements | Check `electron-builder.yml` has `hardenedRuntime: true` and `entitlements: build/entitlements.mac.plist` |
| `notarytool` returns `Invalid: ...not signed with a valid Developer ID` | Wrong cert (e.g. used "Apple Distribution" instead of "Developer ID Application") | Confirm `mac.identity` in `electron-builder.yml` is the SHA hash of the Developer ID cert (`security find-identity -v -p codesigning`) |
| `notarize: should be a boolean` | electron-builder v26 schema | Use `notarize: true`, not the object form. Team ID comes from `APPLE_TEAM_ID` env var. |
| User sees "Apple could not verify..." after double-clicking DMG | DMG container wasn't signed/notarized (only the .app inside) | Run Step 3 above |
| User doesn't see the update | Release is still in draft, or `latest-mac.yml` is missing from the release | Check release is published; check release assets include all three files |
| Auto-update silently fails (downloads start, never complete) | Filename in `latest-mac.yml` doesn't match the uploaded asset (404 on download URL) | Verify with `python3 -c "import urllib.request; print(urllib.request.urlopen('https://github.com/statusdigitalmarketing/dobius-plus/releases/latest/download/latest-mac.yml').read().decode())"` then HEAD-check each `url:` field. If they 404, your `artifactName` config drifted — see Architecture note above. |
| `GH_TOKEN` not set | Missing or expired | Regenerate at https://github.com/settings/tokens with `repo` scope |

## Build output reference

After a successful build, `dist-electron/` contains:

- `dobius-plus-x.y.z.dmg` — the installer users download
- `dobius-plus-x.y.z-arm64-mac.zip` — used by `electron-updater` for delta updates
- `latest-mac.yml` — manifest the app reads to detect new versions
- `mac-arm64/Dobius+.app` — the unpackaged app (for local testing)
- `*.blockmap` — diff support for delta updates (optional, but ships with default config)

All of `*.dmg`, `*.zip`, and `latest-mac.yml` must be uploaded to the GitHub release for auto-update to work.

## Skipping notarization (local testing only)

If you just want to build a local .app for testing without burning a notarization round-trip:

```bash
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
npm run electron:build
```

The .app will be signed but not notarized. It will run on your machine but other Macs will trigger Gatekeeper warnings.

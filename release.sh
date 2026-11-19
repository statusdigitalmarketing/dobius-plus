#!/bin/bash
# release.sh -- one-command signed/notarized Dobius+ release to GitHub.
#
# Usage:  ./release.sh [patch|minor|major]     (default: patch)
#         ./release.sh resume                  finish the version package.json already holds: bumped and pushed by a
#                                              run that died before publishing (no tag, no release). No new bump.
#
# Automates the full RELEASING.md flow, including the manual DMG steps that
# have to happen in the right order or the release ships subtly broken:
#   1. preflight (clean main, creds present)
#   2. npm version bump
#   3. push main FIRST (so GitHub creates the tag on the right commit)
#   4. electron-builder: build + sign + notarize .app + publish release
#   5. codesign + notarize + staple the DMG container
#   6. regenerate latest-mac.yml's DMG hash (stapling changes the file)
#   7. re-upload manifest + signed DMG
#   8. verify: published, 6 assets, served manifest, tag == main HEAD
#
# Credentials: notarization uses the App Store Connect API key (scripts/lib/asc-client.mjs ascConfig, the same key the
# iOS release uses; ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH override it). GH token from `gh auth token`. Nothing
# secret is echoed. The app-specific password path is gone: Apple stopped accepting it on 2026-11-19, mid-release.
set -euo pipefail
cd "$(dirname "$0")"

BUMP="${1:-patch}"
case "$BUMP" in patch|minor|major|resume) ;; *) echo "usage: ./release.sh [patch|minor|major|resume]" >&2; exit 1 ;; esac

REPO="statusdigitalmarketing/dobius-plus"
IDENTITY="E95B5A61D673D466CCDA22615C9BF0F061BB9F2B"

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

step "Preflight"
[ "$(git branch --show-current)" = "main" ] || { echo "ERROR: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "ERROR: working tree not clean" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || [ -n "$(git log origin/main..HEAD --oneline)" ] || { echo "ERROR: local main is behind origin/main" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authed" >&2; exit 1; }
security find-identity -v -p codesigning | grep -q "$IDENTITY" || { echo "ERROR: signing identity not in Keychain" >&2; exit 1; }
xcrun --find notarytool >/dev/null || { echo "ERROR: notarytool missing" >&2; exit 1; }
# node_modules must match package.json BEFORE the version bump: a dependency merged from another worktree and never
# installed here passed npm test and failed the esbuild step after 2.2.33 was already bumped and pushed.
# Read straight from disk, not npm ls: inherited npm config (NODE_ENV, omit, package-lock-only, link) changes what
# npm ls checks (Codex r1, r2). Every direct dependency must be installed at the version package-lock.json records.
node -e '
const fs = require("fs"), read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const p = read("package.json"), lockFile = read("package-lock.json");
const lock = lockFile.packages || {}, v1 = lockFile.dependencies || {};
const bad = [];
for (const n of Object.keys({ ...p.dependencies, ...p.devDependencies })) {
  // A file: dependency is a link whose version sits on its target record; a v1 lockfile has only `dependencies`, where
  // a file: dependency records its path instead of a version, so only its presence is checked (Codex r3, r4).
  const entry = lock["node_modules/" + n];
  const want = (entry?.link ? lock[entry.resolved] : entry)?.version ?? v1[n]?.version;
  let have = null, why = "nothing";
  try { have = JSON.parse(fs.readFileSync("node_modules/" + n + "/package.json", "utf8")).version || null; }
  catch (e) { if (e.code !== "ENOENT") why = "an unreadable package.json (" + (e.code || e.message) + ")"; }
  if (!want) bad.push(n + " (not in package-lock.json)");
  else if (/^(file|link):/.test(want) ? !have : have !== want) bad.push(n + " (installed " + (have || why) + ", lockfile " + want + ")");
}
if (bad.length) { console.error("ERROR: node_modules does not match the lockfile; run npm install:\n  " + bad.join("\n  ")); process.exit(1); }
' || exit 1
# electron-builder takes the Apple ID path whenever APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD is set, even with the key
# set too, and a keychain profile next: none of them may come in from the shell.
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_KEYCHAIN APPLE_KEYCHAIN_PROFILE
export APPLE_TEAM_ID="Z349CC556Z"
IFS=$'\t' read -r APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY < <(node --input-type=module -e '
import { ascConfig } from "./scripts/lib/asc-client.mjs";
const c = ascConfig();
process.stdout.write([c.keyId, c.issuerId, c.keyPath].join("\t") + "\n");
') || { echo "ERROR: could not read the App Store Connect key settings" >&2; exit 1; }
# Checked before anything prints them (a key's contents put in a variable by mistake would land in the log).
[[ "$APPLE_API_KEY_ID" =~ ^[A-Z0-9]{8,12}$ ]] || { echo "ERROR: ASC_KEY_ID is not an App Store Connect key id" >&2; exit 1; }
[[ "$APPLE_API_ISSUER" =~ ^[0-9a-f-]{36}$ ]] || { echo "ERROR: ASC_ISSUER_ID is not an App Store Connect issuer id" >&2; exit 1; }
[ -r "$APPLE_API_KEY" ] || { echo "ERROR: the App Store Connect key file (ASC_KEY_PATH) is missing or unreadable" >&2; exit 1; }
export APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
# electron-builder reads electron-builder.env in the project folder and adds every variable not already set, so a
# stale APPLE_ID there would bring back the Apple ID path the unset above removed (Codex). Read with the same parser.
node -e '
const fs = require("fs");
let data; try { data = fs.readFileSync("electron-builder.env", "utf8"); } catch (e) { if (e.code === "ENOENT") process.exit(0); throw e; }
const bad = Object.keys(require("dotenv").parse(data)).filter((k) => /^APPLE_(ID|APP_SPECIFIC_PASSWORD|KEYCHAIN|KEYCHAIN_PROFILE)$/.test(k));
if (bad.length) { console.error("ERROR: electron-builder.env sets " + bad.join(", ") + ", which would replace the App Store Connect key; remove them"); process.exit(1); }
' || exit 1
# Ask Apple before anything is bumped or pushed: a credential Apple refuses used to fail only at the notarize step,
# after the version was already public (2.2.42).
xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" >/dev/null 2>&1 \
  || { echo "ERROR: Apple refused the App Store Connect key for notarization (notarytool history failed); nothing was bumped" >&2; exit 1; }
GH_TOKEN="$(gh auth token)"
export GH_TOKEN
# The commit is pinned BEFORE the tests and checked after: a commit landing while they run was never tested.
TESTED_SHA="$(git rev-parse HEAD)"
# The What's new popup needs this release's notes (electron/whats-new/<version>.md). Checked against the pinned commit's
# version: HEAD is confirmed unmoved after the tests, so the bump below is from this same version.
node scripts/whats-new-check.mjs "$([ "$BUMP" = resume ] && echo current || echo "$BUMP")" >/dev/null || exit 1
if [ "$BUMP" = resume ]; then
  # Only a version a release run bumped and pushed, that never got a tag or a release (draft included).
  V="$(node -p "require('./package.json').version")"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "ERROR: resume releases what origin/main holds; push or drop local commits first" >&2; exit 1; }
  # No -q: grep leaving early would SIGPIPE git log, and pipefail would read a match as a failure.
  git log --format=%s HEAD | grep -xF "$V" >/dev/null || { echo "ERROR: no version commit \"$V\" on main; resume only finishes a bumped version" >&2; exit 1; }
  # A lookup that fails stops the run: read as "absent", it would let a live release be overwritten (Codex).
  REMOTE_TAG="$(git ls-remote origin "refs/tags/v$V")" || { echo "ERROR: could not ask GitHub for tag v$V" >&2; exit 1; }
  # Any tag means this version may have been released already (a release can be deleted with its tag left behind),
  # so it is never resumed over (Codex round 2). One left by a resume that died is removed by hand.
  [ -z "$REMOTE_TAG" ] || { echo "ERROR: tag v$V already exists on GitHub. If a resume died after creating it and no release v$V exists, delete it (git push origin :refs/tags/v$V) and run again" >&2; exit 1; }
  # Every release, drafts included (a draft has no tag yet, so a tag lookup cannot see it).
  RELEASE_TAGS="$(gh api --paginate "repos/${REPO}/releases?per_page=100" --jq '.[].tag_name')" || { echo "ERROR: could not list the GitHub releases" >&2; exit 1; }
  if printf '%s\n' "$RELEASE_TAGS" | grep -xF "v$V" >/dev/null; then echo "ERROR: a release v$V (or its draft) already exists; finish or delete it by hand" >&2; exit 1; fi
fi
npm test >/dev/null 2>&1 || { echo "ERROR: npm test failed; not releasing a red build" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$TESTED_SHA" ] || { echo "ERROR: HEAD moved while the tests ran; run the release again" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "ERROR: the tree changed while the tests ran; run the release again" >&2; exit 1; }
echo "preflight OK (tests green)"

if [ "$BUMP" = resume ]; then
  step "Resume v$V (already bumped and pushed, no new bump)"
  # Main must still be this commit now that the tests are done, and the tag is pushed onto it BEFORE the build:
  # electron-builder names no target commit, so GitHub would otherwise tag whatever main is when the release is
  # created, which a push during the build could move (Codex). An existing tag wins over the default branch.
  git fetch -q origin main
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "ERROR: origin/main moved while the tests ran; run the resume again" >&2; exit 1; }
  # Created through the API, which refuses a tag that already exists: of two resumes started together, only one gets
  # past here (Codex round 2). The local tag moves too: release-notes.mjs reads the range from it.
  gh api -X POST "repos/${REPO}/git/refs" -f ref="refs/tags/v$V" -f sha="$(git rev-parse HEAD)" >/dev/null \
    || { echo "ERROR: could not create tag v$V on GitHub (another run may have created it); nothing was built" >&2; exit 1; }
  git tag -f "v$V" HEAD >/dev/null
else
  step "Version bump ($BUMP)"
  npm version "$BUMP"
  V="$(node -p "require('./package.json').version")"
  echo "version: $V"

  step "Push main first (tag lands on the right commit)"
  git push origin main
fi

step "Build + sign + notarize + publish (electron-builder)"
npm run electron:build -- --publish always
# The release is still a draft here. Refuse an app that lacks a production dependency (2.2.34 shipped without every
# scoped package and died at launch): nobody can update to a draft, and an app that cannot start cannot update itself.
node scripts/verify-packaged-deps.mjs "dist-electron/mac-universal/Dobius+.app/Contents/Resources/app.asar" || { echo "ERROR: the packaged app is incomplete; v$V stays a draft" >&2; exit 1; }
# Everything below replaces files on the release, so it must still be this run's draft. electron-builder succeeds
# without uploading when it finds the release already published (another run got there first), and re-uploading the
# manifest and DMG onto that live release would pair them with the other run's zip (Codex round 2).
IS_DRAFT="$(gh release view "v$V" --json isDraft --jq .isDraft)" || { echo "ERROR: could not read release v$V after the build" >&2; exit 1; }
[ "$IS_DRAFT" = "true" ] || { echo "ERROR: release v$V is already published (another run?); not touching its files" >&2; exit 1; }

step "Sign + notarize + staple the DMG container"
DMG="dist-electron/dobius-plus-${V}.dmg"
codesign --sign "$IDENTITY" --timestamp "$DMG"
./scripts/notarize-dmg.sh "$DMG"
xcrun stapler staple "$DMG"
# Retry: right after stapling, Gatekeeper's ticket lookup can transiently
# fail (v1.0.61 release: stapler said "validate action worked" and spctl
# rejected anyway, then accepted on manual re-run a minute later, leaving the
# manifest/re-upload steps unrun). Give propagation up to a minute.
SPCTL_OK=""
for i in 1 2 3 4; do
  if spctl -a -vvv -t install "$DMG" 2>&1 | grep -q "Notarized Developer ID"; then SPCTL_OK=1; break; fi
  echo "spctl not accepting yet (attempt $i), waiting 15s..."
  sleep 15
done
[ -n "$SPCTL_OK" ] || { echo "ERROR: DMG failed spctl verify after 4 attempts" >&2; exit 1; }
echo "DMG verified: Notarized Developer ID"

step "Regenerate manifest DMG hash + re-upload"
( cd dist-electron && node -e '
const fs=require("fs"), cp=require("child_process");
const v=process.argv[1], dmg=`dobius-plus-${v}.dmg`;
const size=fs.statSync(dmg).size;
const hash=cp.execSync(`openssl dgst -sha512 -binary "${dmg}" | openssl base64 -A`).toString().trim();
let y=fs.readFileSync("latest-mac.yml","utf8");
const out=y.replace(new RegExp(`(  - url: ${dmg.replace(/\./g,"\\.")}\\n    sha512: )[^\\n]+(\\n    size: )\\d+`), `$1${hash}$2${size}`);
if(out===y){console.error("PATCH FAILED: dmg entry not matched");process.exit(1);}
fs.writeFileSync("latest-mac.yml",out);
console.log("patched dmg entry -> size="+size);
' "$V" )
gh release upload "v$V" dist-electron/latest-mac.yml --clobber
gh release upload "v$V" "$DMG" --clobber
# Stable-named copy of the SAME signed+stapled DMG, so the permanent link
# github.com/<repo>/releases/latest/download/Dobius-Plus.dmg survives every
# release (version-stamped names rot in buttons/emails; this one never does).
cp "$DMG" dist-electron/Dobius-Plus.dmg
gh release upload "v$V" dist-electron/Dobius-Plus.dmg --clobber

step "Publish the draft (atomic go-live with all 6 assets)"
# Notes first: the Updates panel shows the body, and every release from 2.1.8 to 2.2.17 went out without one.
# A failure here only costs the notes, never the release.
{ node scripts/release-notes.mjs "v$V" > dist-electron/release-notes.md && gh release edit "v$V" --notes-file dist-electron/release-notes.md; } || echo "WARN: release notes not set; add them with: gh release edit v$V --notes-file <file>" >&2
gh release edit "v$V" --draft=false

step "Verify release"
STATUS="$(gh release view "v$V" --json isDraft,isPrerelease,assets --jq '"draft=\(.isDraft) prerelease=\(.isPrerelease) assets=\(.assets|length)"')"
echo "$STATUS"
# The 6 Mac assets, counted apart from the Windows ones the CI job (release: published) attaches a few minutes later
# (Setup .exe, its blockmap, latest.yml), so a quick Windows build can never stand in for a missing Mac file.
MAC_ASSETS="$(gh release view "v$V" --json assets --jq '[.assets[].name | select(test("\\.exe(\\.blockmap)?$|^latest\\.yml$") | not)] | length')"
echo "$STATUS" | grep -qE "draft=false prerelease=false" && [ "$MAC_ASSETS" = "6" ] || { echo "ERROR: release not fully published with its 6 Mac assets ($MAC_ASSETS)" >&2; exit 1; }
SERVED="$(curl -sL "https://github.com/${REPO}/releases/latest/download/latest-mac.yml" | head -1)"
echo "served manifest: $SERVED"
[ "$SERVED" = "version: $V" ] || { echo "ERROR: served manifest is not $V (CDN lag? re-check in 1 min)" >&2; exit 1; }
TAG_SHA="$(gh api "repos/${REPO}/git/refs/tags/v$V" --jq '.object.sha')"
HEAD_SHA="$(git rev-parse HEAD)"
[ "$TAG_SHA" = "$HEAD_SHA" ] || { echo "ERROR: remote tag v$V ($TAG_SHA) != main HEAD ($HEAD_SHA)" >&2; exit 1; }
echo "tag v$V on $TAG_SHA == main HEAD"

step "Done"
echo "v$V is live: https://github.com/${REPO}/releases/tag/v$V"
echo "Users auto-update within 30s of next launch (or 4h if running)."

# The phone app: a new App Store build when the phone code changed since the last one, submitted for review and
# released by Apple on approval (docs/ios-release.md). The desktop release above is already live, so this never fails
# it: a problem is printed with the command to finish by hand.
# DOBIUS_SKIP_IOS=1 skips it. The GitHub token is not passed down.
if [ "${DOBIUS_SKIP_IOS:-}" != "1" ]; then
  step "iOS (App Store)"
  # The tests ran on TESTED_SHA; the release commit is that plus the version bump only. Anything else landing in
  # between means the iOS step runs the tests itself.
  IOS_ARGS=(release --if-changed --expect-sha "$HEAD_SHA")
  # And in those two files only the version fields: a lifecycle hook that also moved a dependency gets tested (Codex).
  version_only() {
    node -e '
      const { execFileSync } = require("child_process");
      const [a, b] = process.argv.slice(1);
      const read = (sha, f) => { try { return JSON.parse(execFileSync("git", ["show", `${sha}:${f}`], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 60000, killSignal: "SIGKILL" })); } catch { return null; } };
      const bare = (f, j) => { if (!j) return String(j); delete j.version; if (f === "package-lock.json" && j.packages && j.packages[""]) delete j.packages[""].version; return JSON.stringify(j); };
      for (const f of ["package.json", "package-lock.json"]) if (bare(f, read(a, f)) !== bare(f, read(b, f))) process.exit(1);
    ' "$TESTED_SHA" "$HEAD_SHA"
  }
  if [ "$(git rev-parse "$HEAD_SHA^")" = "$TESTED_SHA" ] && [ -z "$(git diff --name-only "$TESTED_SHA" "$HEAD_SHA" -- . ':!package.json' ':!package-lock.json')" ] && version_only; then
    IOS_ARGS+=(--skip-tests)
  fi
  # The run watches this shell too: cancelling release.sh stops the iOS release (Codex round 9).
  if env -u GH_TOKEN DOBIUS_IOS_RELEASE_STARTER=$$ node scripts/ios-release.mjs "${IOS_ARGS[@]}"; then
    echo "iOS step finished"
  else
    echo "WARNING: the iOS step did not finish (desktop v$V is live regardless). Finish it with: node scripts/ios-release.mjs release --if-changed" >&2
  fi
fi

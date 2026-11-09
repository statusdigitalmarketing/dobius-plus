#!/bin/bash
# release.sh -- one-command signed/notarized Dobius+ release to GitHub.
#
# Usage:  ./release.sh [patch|minor|major]     (default: patch)
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
# Credentials: notary password from Keychain (service dobius-notary-password),
# GH token from `gh auth token`. Nothing is echoed.
set -euo pipefail
cd "$(dirname "$0")"

BUMP="${1:-patch}"
case "$BUMP" in patch|minor|major) ;; *) echo "usage: ./release.sh [patch|minor|major]" >&2; exit 1 ;; esac

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
export APPLE_ID="sahil.nihal09@gmail.com"
export APPLE_TEAM_ID="Z349CC556Z"
APPLE_APP_SPECIFIC_PASSWORD="$(security find-generic-password -s dobius-notary-password -w)" || { echo "ERROR: notary password not in Keychain (service dobius-notary-password)" >&2; exit 1; }
export APPLE_APP_SPECIFIC_PASSWORD
GH_TOKEN="$(gh auth token)"
export GH_TOKEN
# The commit is pinned BEFORE the tests and checked after: a commit landing while they run was never tested.
TESTED_SHA="$(git rev-parse HEAD)"
npm test >/dev/null 2>&1 || { echo "ERROR: npm test failed; not releasing a red build" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$TESTED_SHA" ] || { echo "ERROR: HEAD moved while the tests ran; run the release again" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "ERROR: the tree changed while the tests ran; run the release again" >&2; exit 1; }
echo "preflight OK (tests green)"

step "Version bump ($BUMP)"
npm version "$BUMP"
V="$(node -p "require('./package.json').version")"
echo "version: $V"

step "Push main first (tag lands on the right commit)"
git push origin main

step "Build + sign + notarize + publish (electron-builder)"
npm run electron:build -- --publish always

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
# DOBIUS_SKIP_IOS=1 skips it. The notary password and GitHub token are not passed down.
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
  if env -u GH_TOKEN -u APPLE_APP_SPECIFIC_PASSWORD node scripts/ios-release.mjs "${IOS_ARGS[@]}"; then
    echo "iOS step finished"
  else
    echo "WARNING: the iOS step did not finish (desktop v$V is live regardless). Finish it with: node scripts/ios-release.mjs release --if-changed" >&2
  fi
fi

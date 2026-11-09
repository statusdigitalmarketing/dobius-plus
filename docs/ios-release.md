# iOS auto-release (`scripts/ios-release.mjs`)

The App Store app bundles its own copy of the phone UI (`mobile/`, built into `dist-mobile`, copied into the app by
`cap sync`). A phone change reaches App Store users only through a new iOS build, so every Dobius release that touches
the phone ships one, and Apple releases it on its own as soon as review approves it.

## Commands

```bash
node scripts/ios-release.mjs status                 # what is live, in review, waiting; newest builds
node scripts/ios-release.mjs release                # test, build, check, upload, wait for processing, submit
node scripts/ios-release.mjs release --if-changed   # same, but only build when the phone code changed since the last iOS build
node scripts/ios-release.mjs release --dry-run      # print the plan, change nothing (no build, no upload, no ASC writes)
node scripts/ios-release.mjs release --no-submit    # build and upload only
node scripts/ios-release.mjs release --no-upload    # build, sign, check and validate with Apple, upload nothing (a ship-test)
node scripts/ios-release.mjs release --notes "..."  # the "What's New" text (default: a plain sentence)
node scripts/ios-release.mjs submit                 # no build: submit the newest processed build of ours not live yet
```

Flags `release.sh` uses: `--expect-sha <sha>` (stop unless HEAD is that commit) and `--skip-tests` (the tests already
ran on that commit). `--allow-branch` builds from a branch other than main; such a build is never submitted, because
only builds tagged on a commit of `origin/main` are. A second run while one is going stops at once (a kernel file lock
through `/usr/bin/lockf`, released however the first one ends).

`release.sh` runs `release --if-changed --expect-sha <HEAD> --skip-tests` after a desktop release is published.
A failure there never fails the desktop release: it prints what to run by hand. `DOBIUS_SKIP_IOS=1` skips it.

## What `release` does

1. **Checks.** The API key is present and named `AuthKey_<id>.p8`; the tree is clean; on main; HEAD is the expected
   commit and is on origin.
2. **Reads App Store Connect.** The app (bundle id `com.statusdigital.dobiusplus`), its iOS versions and newest builds,
   and decides the version (below). A version that cannot ship stops it before anything is built.
3. **Decides whether to build.** `--if-changed` compares HEAD with the commit of the last uploaded build (the highest
   `ios-<version>-<N>` tag that is an ancestor of HEAD and whose build Apple lists and did not refuse) over the paths that end up in the app: `mobile/`, `shared/` (the
   only outside folder phone screens import, checked by a test), `ios/`, `capacitor.config.json`,
   `vite.mobile.config.js`, the installed dependency set in `package-lock.json`, and `package.json` (the version line,
   bumped by every release, does not count in either). It also skips the build when this version already has a build
   of ours that Apple did not refuse. With no build, the submit step below still runs.
4. **Tests, builds, checks the signed app, uploads.** `npm test` in the checkout, then everything else in a fresh
   checkout of exactly that commit (`git worktree add --detach`) with the dependencies the lockfile names
   (`npm ci --ignore-scripts`), so nothing edited in the main checkout or left over in its `node_modules` reaches the
   app: `npm run build:mobile`, `npx cap sync ios` (which must leave tracked files unchanged), `xcodebuild archive`,
   then `xcodebuild -exportArchive` to a local IPA with automatic signing and the API key for provisioning. Every step
   has a deadline (a signing prompt nobody answers cannot hold the run forever). Version numbers are build settings,
   never written into the project: `MARKETING_VERSION` is the commit's `package.json` version,
   `CURRENT_PROJECT_VERSION` is one more than every build number App Store Connect lists (all pages), the project's
   own, and every `ios-<version>-<N>` tag.
   The IPA is unpacked and checked before upload: bundle id, version and build number in its Info.plist, a strict
   signature check, and its entitlements (`aps-environment` production, no `get-task-allow`, this team and app id). Then
   `altool --validate-app` and `altool --upload-package` with the API key (found by file name through
   `API_PRIVATE_KEYS_DIR`, never on a command line).
5. **Tags and waits.** Once the upload succeeds the commit is tagged `ios-<version>-<N>` (both numbers: Apple lets a
   build number repeat under another version) and the tag pushed. Then it waits for processing (up to 45 minutes,
   polled every 30 seconds). Refused (`INVALID`, `FAILED`): it stops, and that tag no longer counts as the last build.
   Still processing after 45 minutes: it stops there, and a later `submit` (or the next release) submits it.
6. **Submits.** Only a processed build of ours: its version and build string match an `ios-<version>-<N>` tag on a
   commit of `origin/main` exactly, and its number is above the live build's. Builds uploaded by hand, from a branch,
   or under a reused number are never picked. If origin cannot be fetched it does not submit. The version it goes on:
   - a version Apple is already handling (waiting for review, in review, accepted, pending Apple's release, processing,
     waiting for export compliance): nothing is touched; the build waits and a later run submits it.
   - a version approved and waiting for a manual release: never released from here (someone chose a manual release);
     it waits.
   - a version waiting on the agreements (`PENDING_CONTRACT`), or in any state this script does not know: it stops.
   - the build's version must be higher than every version that ever shipped (live, replaced, removed from sale), or it
     stops. Checked at submit as well as before building.
   - an editable version (prepare for submission, rejected, developer rejected, metadata rejected, invalid binary,
     ready for review): reused, its version string set to the build's and its release type to after approval.
   - otherwise a new version, `releaseType: AFTER_APPROVAL`.

   Then it attaches the build, sets "What's New" on every localization, and checks the review details field by field:
   a contact (first and last name, phone, email), notes that mention the demo Mac `demo.dobius` and code `123456`, and a
   demo sign-in when the details say one is required.
   Anything missing is repaired from the live version's details, or it stops if those are incomplete too. Everything is
   read back (version string, release type, What's New, review details) and any difference stops it before review.
   The review submission: one left open by a rejection that holds this version (its rejected item is marked
   resolved), else an open one ready for review, else a new one; a submission holding only other items is left alone.
   It confirms the version's item is there (a removed one does not count), reads the version's build once more, and
   submits.
7. **Apple releases it** on approval (`AFTER_APPROVAL`). Nothing else has to run.

## Rules it keeps

- The marketing version must be higher than every version that ever shipped, or it stops.
- A build number is never reused. A build is tagged once Apple has the upload; one Apple refuses stops counting.
- The .p8 key and the JWT are never printed. Requests go only to `api.appstoreconnect.apple.com`, with redirects
  refused, a 60-second timeout, and an answer that is not JSON, has no data, or is a list cut short treated as an error.
- `--dry-run` makes no build, no tags, no uploads and no App Store Connect changes (it does fetch from origin).
- One run at a time (a lock file in the temp folder).
- App Review needs the demo answered for every screen it shows: a new phone message type a screen depends on must be
  answered in `mobile/demo.js` too (RELEASING-IOS.md).

## Key and ids

`ASC_KEY_ID` (default `RVU59FRA7H`, "Dobius iOS upload", App Manager), `ASC_ISSUER_ID`, and `ASC_KEY_PATH` (default
`~/.appstoreconnect/private_keys/AuthKey_<id>.p8`). App id 6824034165, team Z349CC556Z.

Tests: `npm run test:iosrelease` (`electron/__tests__/ios-release-plan.test.mjs`).

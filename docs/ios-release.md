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
node scripts/ios-release.mjs release --no-upload    # build, sign, check and validate with Apple; uploads and submits nothing (a ship-test)
node scripts/ios-release.mjs release --notes "..."  # the "What's New" text (default: a plain sentence)
node scripts/ios-release.mjs submit                 # no build: submit the newest processed build of ours not live yet
```

Flags `release.sh` uses: `--expect-sha <sha>` (stop unless HEAD is that commit) and `--skip-tests` (the tests already
ran on that commit). `--allow-branch` builds from a branch other than main; such a build is never submitted, because
only builds tagged on a commit of `origin/main` are. A second run while one is going stops at once (a kernel file lock
through `/usr/bin/lockf` on `/tmp/dobius-ios-release.lock`, the same path whatever TMPDIR says, released however the
first one ends; if the lockf process itself is killed, the run stops at its next step or write instead of carrying on
unlocked). Cancelling the command that was started (Ctrl+C, a kill, release.sh stopped) stops the run within seconds:
it ends lockf, and the run also watches the process that started it. Git calls have a deadline, never prompt for a
password, ignore replace refs, and fetch every branch by an explicit refspec (the configured one may leave
`origin/main` stale).
Each step runs in its own process group: a timeout, a lost lock or an interrupt stops the step and everything it
started, and a step is over when its own process exits (a helper left holding the output open is stopped, not waited
for). The validate and upload output is kept in a file in the temp folder (one short line names it), never written to the
terminal, so a stalled terminal cannot block the deadlines. The build steps (npm ci, the phone bundle, cap sync,
archive, export, altool) run with only PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, TERM and DEVELOPER_DIR from
the environment, and npm is pointed at empty user and global config files: a variable such as XCODE_XCCONFIG_FILE or
npm_config_registry, or a `node-options` line in `~/.npmrc`, could otherwise change the app without changing the commit.
Synchronous helpers (`security`, `plutil`) are killed with SIGKILL on their deadline, which also ends a stopped one. Accepted: the script's own short status lines are still written as they happen,
so a terminal stalled for good still holds the run.

`release.sh` runs `release --if-changed --expect-sha <HEAD>` after a desktop release is published, with `--skip-tests`
only when the release commit is the tested commit plus a change to the version fields of `package.json` and
`package-lock.json` and nothing else.
A failure there never fails the desktop release: it prints what to run by hand. `DOBIUS_SKIP_IOS=1` skips it.

## What `release` does

1. **Checks.** The API key is present and named `AuthKey_<id>.p8`; the tree is clean; on main; HEAD is the expected
   commit and is on origin.
2. **Reads App Store Connect.** The app (bundle id `com.statusdigital.dobiusplus`), its iOS versions and newest builds,
   and decides the version (below). A version that cannot ship stops it before anything is built.
3. **Decides whether to build.** `--if-changed` compares HEAD with the commit of the last uploaded build (the highest
   `ios-<version>-<N>` tag that is an ancestor of HEAD and whose bound build Apple lists, did not refuse, has not expired, and is the live build or both
   under a version above every shipped one and above the live build: a build that can never ship does not count, so its
   changes build again) over the paths that end up in the app: `mobile/`, `shared/` (the
   only outside folder phone screens import, checked by a test), `ios/`, `capacitor.config.json`,
   `vite.mobile.config.js`, `npm-shrinkwrap.json` (npm prefers it to the lockfile), the installed dependency set in `package-lock.json`, and `package.json` (the version line,
   bumped by every release, does not count in either). A change always builds, even under a version that already has
   a build (that build may be the one App Review rejected). With no build, the submit step below still runs.
4. **Tests, builds, checks the signed app, uploads.** `npm test` in the checkout, then everything else in a fresh
   checkout of exactly that commit (`git worktree add --detach`, with git hooks off, then checked to be at that commit and
clean, and checked again after `cap sync`) with the dependencies the lockfile names
   (`npm ci --include=dev --ignore-scripts`, dev dependencies whatever `NODE_ENV` says: Vite builds the phone bundle), so nothing edited in the main checkout or left over in its `node_modules` reaches the
   app: `npm run build:mobile`, `npx cap sync ios` (which must leave tracked files unchanged), `xcodebuild archive`,
   then `xcodebuild -exportArchive` to a local IPA, signed by hand: an Apple Distribution identity on this Mac (matched to
   App Store Connect's certificate by its SHA-1, with 14+ days left; an existing profile for any of them is used first,
   else the longest-lived one gets a new profile) and an active App Store profile for the app that holds that
   certificate, the push entitlement and at least 14 days of life. When there is none the script makes one through the
   API (`Dobius App Store <date>`) and installs it where Xcode looks. The ARCHIVE still signs automatically (as it does
   on this Mac today): a release Mac where Xcode cannot sign automatically fails at the archive, before anything is
   uploaded. Accepted, since moving the archive to manual signing would need its own ship-test. Automatic export cannot work here: the API key
   cannot use Apple's cloud signing, and Xcode then falls back to a cached profile made before push was added. Every step
   has a deadline (a signing prompt nobody answers cannot hold the run forever). Version numbers are build settings,
   never written into the project: `MARKETING_VERSION` is the commit's `package.json` version,
   `CURRENT_PROJECT_VERSION` is one more than every build number App Store Connect lists (all pages; a dotted one
   such as `100.1` by its first part), the project's own, and every `ios-<version>-<N>` tag. The tests run in the main
   checkout, which must still be exactly that commit before and after them.
   The IPA is unpacked and checked before upload: bundle id, version and build number in its Info.plist, a strict
   signature check, and its entitlements (`aps-environment` production, no `get-task-allow`, this team and app id). Then
   `altool --validate-app` and `altool --upload-package` with the API key (found by file name through
   `API_PRIVATE_KEYS_DIR`, never on a command line).
5. **Tags and waits.** altool must print `UPLOAD SUCCEEDED` (it can exit 0 on a refused upload). Then the commit is
   tagged `ios-<version>-<N>` (both numbers: Apple lets a build number repeat under another version), the tag's message
   recording when the upload began and ended, and the tag pushed. The first time Apple lists the build, the tag is
   rewritten (same commit, force-pushed) with that build's App Store Connect id (`asc-build <id>`). The build is found
   through this run's OWN upload record in App Store Connect (`/v1/apps/{id}/buildUploads`): the record whose id is the
   delivery id altool printed for this upload, nothing else. When that record is COMPLETE it names its build; a FAILED
   record stops the run. Without a delivery id nothing is bound and the run fails at once: numbers and dates cannot tell
   this upload from someone else's of the same numbers made alongside it. Only a bound tag vouches for a build,
   and only for that id. A tag never bound (the run died first, Apple never listed the build, or the binding push
   failed, which stops the run; fetching origin prunes local ios-* tags origin does not have, so a binding that never
   reached origin does not count) vouches for nothing: Apple lets a failed upload's numbers be reused, so a later match
   could be someone else's binary. Its commit simply builds again next time. Then it waits for processing (up to 45 minutes,
   polled every 30 seconds). Refused (`INVALID`, `FAILED`): it stops, and that tag no longer counts as the last build.
   Still processing after 45 minutes: it stops there, and a later `submit` (or the next release) submits it, provided
   the tag was bound (Apple lists a build within minutes of the upload, processing or not).
6. **Submits.** Only a processed build of ours: its version and build string match an `ios-<version>-<N>` tag on a
   commit of `origin/main` exactly and is the build that tag vouches for, it has not expired, its version is above every shipped one (so a build that can never ship does not hide one that
can), and it is above the live build in Apple's order (a live `100.1`
   keeps out a 7; a live build string that cannot be read keeps out everything). Builds uploaded by hand, from a branch,
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
   a contact (first and last name, phone, email), notes that mention the demo Mac `demo.dobius` (bare, or exactly
   `demo.dobius:8420` or `http://demo.dobius:8420`, every mention: `https://`, `http://` without the port, another
   port, a longer host such as `staging.demo.dobius` or `notdemo.dobius`, or the name inside another address reaches no
Mac)
   and code `123456`, and a
   demo sign-in when the details say one is required.
   Anything missing is repaired from the live version's details, or it stops if those are incomplete too. Everything is
   read back (version string, release type, What's New, review details) and any difference stops it before review.
   The review submission: one left open by a rejection that holds this version (its rejected item is marked
   resolved), else a draft holding only this version, else an empty draft, else a new one. Drafts holding anything else
   (an In-App Event, another version) are left alone. A version that already sits in an open submission next to other
   items stops the run BEFORE anything is written to it. Right before submitting it reads the version's build once
   more, then the items (this version there, a removed one not counting, nothing else added since), then submits at
   once: submitting sends every item. Apple has no conditional submit, so an item added between that last read and the
   submit request would still go with it.
7. **Apple releases it** on approval (`AFTER_APPROVAL`). Nothing else has to run.

## Rules it keeps

- The marketing version must be higher than every version that ever shipped, or it stops.
- A build number is never reused. A build is tagged once Apple has the upload; one Apple refuses stops counting.
- The .p8 key and the JWT are never printed. Requests go only to `api.appstoreconnect.apple.com`, with redirects
  refused, a 60-second timeout, and an answer that is not JSON, has no data, or is a list cut short treated as an error.
- `--dry-run` makes no build, no tags, no uploads, no App Store Connect changes and installs no profile (it fetches
  origin's branches, never its tags: it holds no lock, so it reads the tags it already has).
- One run at a time (`/tmp/dobius-ios-release.lock`).
- A version left in a draft submission by a run that stopped is taken out of the draft before its build changes (Apple
  keeps a draft's build fixed), then added back. The submit is tried up to 6 times, 10 seconds apart, while Apple
  answers 409 (it moves a version into its ready state on its own time), with the build and item checks before each.
- Accepted, not handled: git checkout filters (smudge/clean) configured on this Mac apply to the clean checkout the
  build uses. Setting one up takes write access to this user's git config, which can already change the build in
  many other ways.
- Accepted, not handled: after App Review rejects a version, a run that marked the rejection resolved and then
  stopped before submitting leaves the version's build fixed inside the rejected submission. The next run's build
  change is refused by Apple (409) and the run fails loudly; nothing is shipped. A rejection needs a person in App
  Store Connect anyway, and they finish it there.
- Cancelling release.sh, the started command or its lockf stops the run within seconds: the run watches all three.
- The archive uses the committed `Package.resolved` (`-disableAutomaticPackageResolution`); a pin out of step with
  `Package.swift` fails the build instead of Xcode choosing other package versions.
- App Review needs the demo answered for every screen it shows: a new phone message type a screen depends on must be
  answered in `mobile/demo.js` too (RELEASING-IOS.md).

## Key and ids

`ASC_KEY_ID` (default `RVU59FRA7H`, "Dobius iOS upload", App Manager), `ASC_ISSUER_ID`, and `ASC_KEY_PATH` (default
`~/.appstoreconnect/private_keys/AuthKey_<id>.p8`). App id 6824034165, team Z349CC556Z.

Tests: `npm run test:iosrelease` (`electron/__tests__/ios-release-plan.test.mjs`).

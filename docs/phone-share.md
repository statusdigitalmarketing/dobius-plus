# Share to Dobius+ from the iPhone

Sam, 2026-11-19: share a screenshot (or any image, text or link) from the iPhone share sheet straight into a Dobius tab,
without copying it, opening Dobius and pasting.

## Path chosen and why

The phone app is a Capacitor iOS app already on the App Store (`ios/App`), with the phone UI bundled. iOS Safari has no
Web Share Target, so the home-screen PWA can never appear in the share sheet; the native app can, through a **Share
Extension** (`ios/App/DobiusShare`), a second small target inside the same app. Nothing new to install for Sam: the
next App Store update of Dobius+ carries it.

There is no relay. The phone talks straight to the Mac over Tailscale (WireGuard), with the per-device bearer token from
pairing. The extension does exactly the same: same origins, same tokens, same `Authorization: Bearer` checks, and no
new unauthenticated route.

## How the extension gets the pairings

The extension runs in its own sandbox and cannot read the app's `@capacitor/preferences`. The app mirrors the paired
Macs (id, name, origin, token, which one is active) into ONE Keychain item in a shared access group,
`Z349CC556Z.com.statusdigital.dobiusplus.shared` (service `com.statusdigital.dobiusplus.share`, account `pairings`,
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), through a small in-app Capacitor plugin (`DobiusShare`,
`mobile/share-mirror.js` on the web side). Keychain sharing within one team needs no App ID capability (every profile
carries `keychain-access-groups = Z349CC556Z.*`), so no App Group has to be registered.

- Written whenever the pairing document changes (add, rename, remove, switch) and once at launch. A removed Mac (or a
  replaced token) leaves the Keychain copy BEFORE the pairing document is saved, so the app dying between the two writes
  never leaves the extension a token the app no longer keeps.
- The demo pairing (`demo.dobius`, App Review) is mirrored too; the extension answers it locally with sample tabs and
  never makes a network call for it.
- The extension keeps only its own convenience state (last tab used per Mac) in its own UserDefaults.

## Mac side (`electron/phone-share.js`, mounted in `mobile-server.js`)

Both routes sit behind the existing host check, CORS and bearer auth (auth runs before any body is read).

`GET /share/targets` returns the tabs to offer:

```json
{ "ok": true, "mac": "Sam's MacBook Pro", "orchestrator": "term-/Users/sam/x-2",
  "tabs": [ { "id": "term-/Users/sam/x-2", "label": "Global orchestrator loop", "project": "global-orchestrator-2",
              "claude": true, "status": "idle", "lastActivityAt": 1795000000000, "orchestrator": true } ] }
```

Order: the team orchestrator tab first, then Claude tabs by last activity, then the rest. At most 40.

`POST /share?tab=<tab id>&kind=image|text&note=<optional, URL-encoded>` with a raw body:

- `kind=image`: PNG, JPEG, GIF or WebP bytes (checked by magic number, not by name), at most 12 MB. Saved to the same
  `tmpdir/dobius-mobile-uploads` folder `/upload` uses (24 h prune, and capped at 512 MB / 300 files, oldest first), then
  the path goes into the tab's Claude prompt on a line of its own after the note. Claude Code turns that line into an
  `[Image #N]` attachment and moves it to the front of the box: `[Image #1][shared from the phone] look at this`
  (checked live on 2.1.328). `sendToTab` is told which paths it pasted (`images`), so that exact form counts as "the box
  holds our message" and Enter is pressed; a send that names no image never accepts a marker. A share nothing was typed
  for deletes its image at once.
- `kind=text`: UTF-8 text or a link, at most 32 KB.
- The note (at most 2000 characters) leads the message.
- Delivered with `sendToTab(..., { claudeOnly: true })`: every dobius-send guard applies (never into a draft, an open
  question or a shell), and the answer says whether it was sent, typed but not confirmed, or refused and why.
- **One share at a time** on the whole Mac, claimed before the body is read: a second one while the first is still in
  flight gets 429 `busy` without being buffered. Nothing queues on the Mac. A delivery that has not settled after 45 s
  frees the lock and answers 504 `uncertain` (never "sent"); sendToTab's own per-tab lock still keeps a second paste out
  of that tab.
- `id=<uuid>` (the extension sends one per share): a retry after a lost answer gets the first result again
  (`repeat: true`) instead of a second paste; a retry while the first is still running gets 409 `in-progress`
  (`uncertain`). A receipt answers only for the same tab, kind and note (else 409 `id-reused`). At most 200 receipts,
  for an hour, never evicting one whose delivery is still running; a delivery that finishes after its deadline replaces
  the `uncertain` receipt with what happened. Receipts live in one process-wide state, so a phone server restart
  (certificate renewal) does not forget them.
- At most 4 deliveries may still be running (past their deadline too); beyond that new shares get 429 `busy`.
- The device's token is checked on arrival, again once the body has arrived, and again (through `sendToTab`'s
  `allowed`) right before the paste and right before Enter: a phone removed mid-share types nothing more.
- Compressed bodies are refused (415). An image is protected from the upload prune while its delivery runs, and for
  10 minutes after a typed-but-unconfirmed outcome (Claude may still read the queued paste), at most 16 kept.

Replies: `{ ok: true, sent: true, label }`, `{ ok: true, typed: true, note }` (in the box, Enter not seen taken; the
sheet says so in orange and stays up until Done), `{ ok: false, uncertain: true, error }` (504), or
`{ ok: false, error, reason? }` with 4xx. `curl` shape:

```bash
curl -H "Authorization: Bearer $TOKEN" http://<mac>:8420/share/targets
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' \
  --data-binary @shot.png "http://<mac>:8420/share?kind=image&tab=<urlencoded tab id>&note=look&id=$(uuidgen)"
```

## The extension (Swift, `ios/App/DobiusShare`)

1. Reads the mirrored pairings from the Keychain. None: "Open Dobius+ and pair with your Mac first."
2. Mac picker when more than one is paired (the app's active Mac first).
3. `GET /share/targets` (8 s timeout). The list: orchestrator pinned at the top with a badge, the last-used tab
   selected (falls back to the orchestrator, then the first tab), then recent tabs.
4. A preview of what is shared and a note field. Send posts once; the button is disabled while the request runs. The
   note is normalized exactly as the Mac's `cleanNote` does (and clipped to 2000 UTF-8 bytes, so the request line stays
   under Node's 16 KB header limit); the share id changes only when the tab or the normalized note changes, or after a
   refusal. A lost answer, a busy Mac or an uncertain outcome keeps the id. The pairing is read again from the Keychain
   at Send, so a Mac removed while the sheet was open is refused.
5. Networking: an ephemeral URLSession, no cookies, redirects refused (a token never follows a redirect). The
   extension's Info.plist sets `NSAllowsArbitraryLoads`: a Mac paired at a tailnet IP (`http://100.x.y.z:8420`) is an
   IP literal, which no ATS exception covers, and `NSAllowsLocalNetworking` does not cover tailnet addresses (verified in
   the simulator: -1022). The extension only ever connects to origins from the app's own pairing list.
6. Images are read as a FILE (`loadFileRepresentation`) and downscaled with ImageIO from disk
   (`CGImageSourceCreateWithURL` + `CGImageSourceCreateThumbnailAtIndex`, longest side 2048 px, refused above 80 MB,
   never decoding or loading the full image). Only an item with no file form (the screenshot editor's UIImage, at most
   16 MP) is drawn down. The extension carries its own `PrivacyInfo.xcprivacy` (UserDefaults, CA92.1) and sent as JPEG at quality 0.85, which keeps a screenshot well under 2 MB and the extension well inside
   its memory limit. Only the first image of a multi-image share is sent (the sheet says so).
7. Success closes the sheet after a short "Sent to <tab>" confirmation; a refusal shows the Mac's reason and keeps the
   sheet open to pick another tab or retry.

## Release

`scripts/ios-release.mjs` signs both bundles: it registers `com.statusdigital.dobiusplus.share` in App Store Connect when
missing, finds or makes an App Store profile for each with the same distribution certificate, and `verifyIpa` refuses an
IPA whose app or extension is not signed for the shared Keychain group (or whose extension version differs).

## Ship-test (2026-11-19)

Isolated dev harness (phone server 8461), the app in the iPhone 17 Pro simulator paired at the raw tailnet IP, and a
throwaway XCUITest project driving the real share sheet: Photos, Share, Dobius+, orchestrator preselected, note, Send.
The harness tab's Claude showed `[Image #1][shared from the phone] <note>`, the turn ran, and Claude described the
screenshot. A share into a tab with no Claude answered 409 and the image was deleted; a wrong token answered 401.

## What Sam needs to do

Nothing beyond updating Dobius+ from the App Store once the build is approved (and updating the Mac app, which carries
the two routes). Then: screenshot, tap Share, pick Dobius+ (first time: More, then turn Dobius+ on and drag it up),
check the tab, add a note if wanted, Send.

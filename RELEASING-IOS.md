# Releasing Dobius+ iOS (TestFlight)

Companion to `RELEASING.md` (which covers the Mac side). This document is for the Capacitor-wrapped iOS app in `ios/`.

## What this build is, exactly

A Capacitor shell that loads the mobile PWA directly from the Mac over Tailscale (`http://sams-macbook-pro.tail6addbf.ts.net:8420`, MagicDNS). Zero mobile code changes. The native iOS binary is a thin WebView wrapper around the same bundle you already use on your phone, just signed and distributable through TestFlight.

Earlier builds pointed `server.url` at the raw Tailscale IP `100.89.143.67`. Apple's App Transport Security ignores `NSExceptionDomains` entries when the key is an IP address (per Apple's own docs, that key accepts DNS names only), so the WebView silently refused to connect even though Safari on the same phone loaded the exact URL fine. Switching to the MagicDNS hostname and declaring `ts.net` with `NSIncludesSubdomains` in `Info.plist` is what unblocked WKWebView.

**Scope limit:** this is a self-use TestFlight artifact. Apple App Store review will reject it as "a webview wrapper of a remote server" (Guideline 4.2). A follow-up build swaps the hardcoded Tailscale URL for a bundled PWA plus a first-run host-pairing screen, which is what gets submitted to the public App Store.

### Security tradeoff we are taking today, explicit

The WebView loads an **HTTP** URL. The deliberate reasons it is safe inside this scope and the exact ways it stops being safe outside it:

- **At the network layer the transport is not cleartext.** Tailscale wraps every byte phone-to-Mac in WireGuard (ChaCha20-Poly1305). No observer on any Wi-Fi, cell, or ISP in between can read, modify, or MITM it. ATS exists to defend against the general-internet case, which does not apply inside a Tailnet.
- **The IP is not spoofable.** `100.89.143.67` belongs to this Mac inside Sam's personal Tailnet. No node can claim that address without being admitted to the Tailnet, which requires his key.
- **Residual risks that only the follow-up PR closes:**
  - The pairing token is in `localStorage` scoped to the HTTP origin `100.89.143.67:8420`. If the WebView ever loaded a hostile page at that origin, that page would read the token. Follow-up moves the token to Keychain via a native plugin.
  - If Tailscale fell off and the device fell back to a regular LAN that happened to use the same `100.x.x.x` address (near-zero but non-zero), the WebView would load that page as the same privileged origin. Follow-up removes `server.url`, serves the bundled PWA from `capacitor://localhost`, and connects out to the Mac only over `wss://<host>.<tailnet>.ts.net` with a Tailscale-issued Let's Encrypt cert.
  - A public App Store build must never reuse this config. The follow-up is where that happens.

**The Tailscale MagicDNS hostname is baked into the build.** Current value: `sams-macbook-pro.tail6addbf.ts.net`. If the Mac's hostname or the tailnet suffix changes (rare), edit `capacitor.config.json`'s `server.url` and `RELEASING-IOS.md`, then `npm run ios:sync`. The `Info.plist` ATS exception is on `ts.net` with subdomains so any `.ts.net` host works without re-editing.

## Prerequisites checked at build time

- Xcode 26.6 (verified)
- CocoaPods via Homebrew (verified)
- Apple Developer Program membership, iOS enabled, team `Z349CC556Z` (SAM: verify this in Xcode when signing. The Mac cert alone does not grant iOS.)
- Target device(s) added to the Apple Developer portal (for direct install, not needed for TestFlight)

## One-time Xcode setup (first archive only)

1. `npm run ios:open` opens `ios/App/App.xcworkspace` in Xcode.
2. Select the **App** target in the project navigator.
3. **Signing & Capabilities tab**:
   - Team: Status Consulting Firm LLC (Z349CC556Z)
   - Automatically manage signing: on
   - Bundle Identifier: `com.statusdigital.dobiusplus` (already set)
4. **General tab**:
   - Deployment Target: iOS 16.0 (or whatever Capacitor set, do not lower)
   - Version: match the Mac app's current version (currently 1.0.79)
   - Build: 1 (increment on every TestFlight upload)
5. If Xcode says "No matching certificates", click Fix Issues and let it generate the iOS Development + Distribution certs for the team.

## Build and upload to TestFlight

Pre-flight, every release:

```bash
npm run build:mobile          # fresh mobile bundle (fallback inside the native binary)
npx cap sync ios              # copy bundle + config into ios/
npm run ios:open              # open Xcode
```

In Xcode:

1. Select scheme **App**, destination **Any iOS Device (arm64)**.
2. Bump Build number (always +1 vs the previous upload; TestFlight rejects duplicates).
3. **Product -> Archive**. Wait for the archive to finish (3-6 minutes first time).
4. In the Organizer window, select the new archive, click **Distribute App**.
5. Choose **App Store Connect -> Upload**. Follow the signing prompts.
6. When upload completes, go to [App Store Connect](https://appstoreconnect.apple.com), create the app record (first time only, bundle ID `com.statusdigital.dobiusplus`), then under TestFlight add the build.
7. For internal TestFlight (yourself): add your Apple ID as an internal tester. Build is available in ~5 minutes, no review.
8. Install TestFlight on your iPhone, accept the invite from your email, install Dobius+.

**Export compliance:** `Info.plist` already carries `ITSAppUsesNonExemptEncryption=false`, which tells App Store Connect the app uses only exempt encryption (standard HTTPS/TLS/WireGuard, no custom crypto). TestFlight no longer prompts a question per build. If Apple ever asks on the first upload, the answer is: Yes, uses encryption, Exempt.

## What breaks and how to spot it

- **Blank black screen on launch**: the Mac was unreachable from the phone over Tailscale when the WebView loaded. The app does NOT auto-recover when the Mac comes back, because `capacitor.config.json` has no `server.errorPath` and so Capacitor never falls back to the bundled PWA. Verify Tailscale is on both devices, Mac is awake, Dobius+ is running, `mobile-server.js` is listening on `100.89.143.67:8420`, then force-quit Dobius+ on the phone and relaunch. The follow-up PR replaces this behavior with an in-app error page + retry. First-ever launch gotcha: if the screen stays pure black, open Safari on the phone and visit the same `http://sams-macbook-pro.tail6addbf.ts.net:8420` URL to confirm the Mac is actually reachable. If Safari loads it but Dobius+ stays black, the ATS exception is wrong (should be on `ts.net` with `NSIncludesSubdomains`, never on a raw IP).
- **"Could not reach Dobius+" at pairing**: same cause. The webview did load, but fetch to `/pair` failed. Open Safari developer tools against the device to confirm.
- **Terminal view renders but keyboard does nothing**: iOS keyboard focus for xterm.js canvas is finicky; falls back to the mobile `Terminal.jsx` path which uses a hidden textarea. If this breaks after an iOS update, start from `mobile/Terminal.jsx` and `mobile/XtermView.jsx`.
- **"ITMS-90717: Invalid App Store Icon"**: alpha channel snuck back into `AppIcon-512@2x.png`. Reflatten:
  ```bash
  python3 -c "from PIL import Image; p='ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'; im=Image.open(p).convert('RGBA'); bg=Image.new('RGB',im.size,(31,30,29)); bg.paste(im,mask=im.split()[3]); bg.save(p,'PNG')"
  ```
- **"ITMS-90078: Missing Push Notification Entitlement"**: the mobile PWA uses push via web standards, not APNs. Push through the iOS binary needs an actual APNs entitlement, which this build does not have, so if that error appears it's a false positive on an unused code path.

## Where the pieces live

- `capacitor.config.json` - app id, name, webDir, remote server URL (the Tailscale IP).
- `ios/App/App/Info.plist` - ATS exceptions for the Tailscale IP; local network usage description.
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/` - 1024x1024 icon (alpha stripped) + Contents.json.
- `ios/App/App.xcodeproj/project.pbxproj` - bundle id, versions, team. Edit through Xcode, not by hand.
- `dist-mobile/` - the mobile PWA bundle. Capacitor copies it into `ios/App/App/public/` on every `cap sync`. With `server.url` set this bundle is NOT loaded at runtime (not a fallback). It only becomes active once the follow-up PR removes `server.url` and switches to `capacitor://localhost`.

## Follow-up PR (public App Store, feat/ios-app-store branch)

Changes landed on `feat/ios-app-store` to pass Apple review:

1. Removed `server.url` from `capacitor.config.json`. The bundled PWA is served from `capacitor://localhost`.
2. Added a first-run Mac host entry step in `mobile/Pairing.jsx`. Accepts bare `host:port`, bare host (defaults to :8420), or a full `http(s)://host:port` URL.
3. Added `mobile/host.js` + `mobile/storage.js`. Stores the Mac origin (scheme + host + port) and pairing token in `@capacitor/preferences` (lands in iOS UserDefaults, scoped per-app).
4. Rewrote `mobile/connection.js` + every relative fetch in ChatView / VoiceButton / push-client to build absolute URLs against the stored origin. `ws://` or `wss://` is derived from the stored scheme.
5. Added a QR code to Mac side Settings, Mobile Access section. The QR encodes `dobiusplus://pair?host=http(s)%3A%2F%2FHOST&code=CODE` and the iOS app parses it via `@capacitor/app`'s `appUrlOpen` listener. The scheme is preserved so an HTTPS Mac pairs with its TLS listener, not plaintext.
6. Added `mobile/Intro.jsx` reachable from the pairing screen's "What is Dobius+?" link, so an Apple reviewer who has no Mac running Dobius+ can see what the app does and how to request a reviewer demo Mac.
7. Added `mobile/public/error.html` plus `server.errorPath` in `capacitor.config.json` for blank-screen recovery with a Retry button.
8. Added permissive CORS middleware to `electron/mobile-server.js` so the `capacitor://localhost` WebView origin can reach every endpoint cross-origin.
9. Added `ios/App/App/PrivacyInfo.xcprivacy` declaring the required-reason API `NSPrivacyAccessedAPICategoryUserDefaults` (reason `CA92.1`) that `@capacitor/preferences` uses. Without this, App Store validation blocks the upload.

### TestFlight build 1 migration

Users upgrading from TestFlight build 1 to the public build will need to re-pair once. The TestFlight build stored its token in `localStorage` under the `http://sams-macbook-pro.tail6addbf.ts.net:8420` origin; the bundled App Store build is served from `capacitor://localhost` and cannot read a different origin's localStorage. Only Sam is a build 1 tester, so this is a one-time cost. The desktop can `Remove` the paired device and regenerate a code, which also prunes the stale token server-side.

### Still deferred

- Pairing token moved from `@capacitor/preferences` (UserDefaults, per-app sandbox) into iOS Keychain via a native plugin. UserDefaults is already a step up from the WebView `localStorage` the TestFlight build used and is good enough for first App Store submission.
- A fully-interactive demo mode (hard-coded sample Board / Terminal) that works without a Mac at all. The Intro screen covers the current reviewer path.

### Accepted residual

Scanning three different QR codes (A, then B, then A again) in rapid succession, while the first A request is still waiting for a response, can submit A's single-use pairing code twice. The first request succeeds on the server, which rotates the code; the second returns "Invalid pairing code" and the user has to tap Pair this device once more. Not a data-loss or security bug: the token from the first success is just dropped because the client has already moved on to a different pairing payload by the time it arrives. The 10-round Codex review traced this to extreme QR juggling that is improbable in real use. Documented here instead of fixed; a future PR can add a request-coalescing cache keyed by payload if it ever surfaces in the wild.

## Also deferred: cosmetic Xcode rename `App` -> `DobiusPlus`

The Capacitor template leaves everything developer-facing named "App": the Xcode project (`ios/App/App.xcodeproj`), the scheme, the target, and the CapApp-SPM Swift package. None of this is user-visible (home screen reads "Dobius+" from `CFBundleDisplayName`; TestFlight and the App Store listing read from App Store Connect), but the archive files and build logs show "App 1.0.79 (1)" which is sloppy.

Rename plan (do this as the first commit of the follow-up PR, before any mobile code changes, so the rename does not tangle with product changes):

1. Rename `ios/App/` directory to `ios/DobiusPlus/` and the `.xcodeproj` with it, via `xed` or by closing Xcode and doing a filesystem move.
2. In the renamed `.xcodeproj/project.pbxproj`, rename the scheme "App" -> "DobiusPlus" and the target "App" -> "DobiusPlus".
3. Rename `ios/App/CapApp-SPM/` to `ios/DobiusPlus/CapAppSPM/` (dash in a Swift package name is awkward; this also fixes that), update `Package.swift` and the `.swift` source file's module declaration.
4. Update every path in `project.pbxproj` that still references `App/App/...` or `CapApp-SPM`.
5. Update `capacitor.config.json` and anything in `electron/` that spawns iOS tooling to use the new path.
6. Run `npm run build:mobile && npx cap sync ios` to re-sync into the renamed tree.
7. Fresh Archive from the renamed project; archive now reads `DobiusPlus 1.0.80 (1)`.

Risky because paths are strewn through the pbxproj. Must be its own commit, no mixed changes, verified by a round-trip Archive before merge.

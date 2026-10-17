# Releasing Dobius+ iOS (TestFlight)

Companion to `RELEASING.md` (which covers the Mac side). This document is for the Capacitor-wrapped iOS app in `ios/`.

## What this build is, exactly

A Capacitor shell that loads the mobile PWA directly from the Mac over Tailscale (`http://100.89.143.67:8420`). Zero mobile code changes. The native iOS binary is a thin WebView wrapper around the same bundle you already use on your phone, just signed and distributable through TestFlight.

**Scope limit:** this is a self-use TestFlight artifact. Apple App Store review will reject it as "a webview wrapper of a remote server" (Guideline 4.2). A follow-up build swaps the hardcoded Tailscale URL for a bundled PWA plus a first-run host-pairing screen, which is what gets submitted to the public App Store.

### Security tradeoff we are taking today, explicit

The WebView loads an **HTTP** URL. The deliberate reasons it is safe inside this scope and the exact ways it stops being safe outside it:

- **At the network layer the transport is not cleartext.** Tailscale wraps every byte phone-to-Mac in WireGuard (ChaCha20-Poly1305). No observer on any Wi-Fi, cell, or ISP in between can read, modify, or MITM it. ATS exists to defend against the general-internet case, which does not apply inside a Tailnet.
- **The IP is not spoofable.** `100.89.143.67` belongs to this Mac inside Sam's personal Tailnet. No node can claim that address without being admitted to the Tailnet, which requires his key.
- **Residual risks that only the follow-up PR closes:**
  - The pairing token is in `localStorage` scoped to the HTTP origin `100.89.143.67:8420`. If the WebView ever loaded a hostile page at that origin, that page would read the token. Follow-up moves the token to Keychain via a native plugin.
  - If Tailscale fell off and the device fell back to a regular LAN that happened to use the same `100.x.x.x` address (near-zero but non-zero), the WebView would load that page as the same privileged origin. Follow-up removes `server.url`, serves the bundled PWA from `capacitor://localhost`, and connects out to the Mac only over `wss://<host>.<tailnet>.ts.net` with a Tailscale-issued Let's Encrypt cert.
  - A public App Store build must never reuse this config. The follow-up is where that happens.

**The Tailscale IP is baked into the build.** If your Mac's Tailscale IP changes, rebuild. Current value: `100.89.143.67` (sams-macbook-pro). Edit `capacitor.config.json` and `ios/App/App/Info.plist` ATS exception, then `npm run ios:sync`.

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

- **Blank white screen on launch**: the Mac was unreachable from the phone over Tailscale when the WebView loaded. The app does NOT auto-recover when the Mac comes back, because `capacitor.config.json` has no `server.errorPath` and so Capacitor never falls back to the bundled PWA. Verify Tailscale is on, Mac is awake, Dobius+ is running, `mobile-server.js` is listening on `100.89.143.67:8420`, then force-quit Dobius+ on the phone and relaunch. The follow-up PR replaces this behavior with an in-app error page + retry.
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

## Follow-up PR (public App Store, deferred from today's push)

To get past Apple review for the public App Store:

1. Remove `server.url` from `capacitor.config.json`.
2. Add a first-run **Mac host entry** step to `mobile/Pairing.jsx` (asks for Tailscale IP or MagicDNS name).
3. Change `mobile/connection.js` to read the stored host instead of `location.host`.
4. Make `./pair` fetch use the stored host as an absolute URL.
5. On the Mac side, generate a QR code of `dobiusplus://pair?host=100.x.x.x:8420&code=123456` so the phone can set host + code in one scan.
6. Submit with a demo mode or demo credentials so Apple's reviewer can exercise the app without being on Sam's Tailnet.
7. Replace `server.errorPath`-less blank-screen behavior with a bundled `error.html` offering a Retry button, wired into `capacitor.config.json` as `server.errorPath`.
8. Move the pairing token from `localStorage` (origin-scoped to the HTTP host) into the iOS Keychain via a native Capacitor plugin.

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

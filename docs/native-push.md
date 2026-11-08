# Native push for the App Store app (APNs)

The phone PWA added to the Home Screen gets notifications through Web Push (`electron/push.js`). The App Store app is a
Capacitor WKWebView, which has no `PushManager`, so it never could. It now uses Apple Push Notification service:

- The app asks iOS for a device token (`@capacitor/push-notifications`, `mobile/native-push.js`) and gives it to each
  paired Mac over that Mac's authed WebSocket (`apnsRegister`). The Mac stores it bound to that phone's pairing, so
  unpairing the phone removes it.
- The Mac sends through Apple over HTTP/2 with an ES256 token signed by your APNs key (`electron/apns.js`). Every
  notification Dobius sends to phones (phone Settings > Notifications, and Today's phone nudge) goes to Web Push
  subscribers and APNs devices alike (`electron/phone-push.js`).
- Without a key on the Mac nothing is sent through Apple, and the phone's Settings says so: "Your Mac cannot send to
  this app yet: its Apple push key is not set up."

## What Sam does, once

### 1. Create the APNs key (Apple developer portal)

1. Go to https://developer.apple.com/account/resources/authkeys/list (Certificates, Identifiers & Profiles, Keys).
2. Click **+**. Name it `Dobius+ push`. Tick **Apple Push Notifications service (APNs)**. Configure: environment
   **Sandbox & Production**, key restriction **Team Scoped (All Topics)**. Continue, Register.
3. **Download** the key. It is `AuthKey_XXXXXXXXXX.p8`; the ten characters are the Key ID. Apple lets you download it
   once only: keep a copy in your password manager.
4. Team ID is `Z349CC556Z` (already the default). The bundle id is `com.statusdigital.dobiusplus` (already the
   default).

### 2. Put the key on each Mac that should send

```
mkdir -p ~/Library/Application\ Support/dobius-plus/apns
chmod 700 ~/Library/Application\ Support/dobius-plus/apns
cp ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/Library/Application\ Support/dobius-plus/apns/
chmod 600 ~/Library/Application\ Support/dobius-plus/apns/AuthKey_*.p8
```

Keep the file name exactly as Apple named it. Exactly one `AuthKey_*.p8` may be in the folder. Dobius reads it within
30 seconds, no restart needed. Only if a value differs from the defaults, add `apns.json` beside it:

```json
{ "teamId": "Z349CC556Z", "bundleId": "com.statusdigital.dobiusplus" }
```

The folder must belong to you and not be a symlink, and so must the key; a looser mode is tightened to 0600 on read.
The key and the signed token are never logged and never go into an error report.

### 3. Turn on the capability in Xcode and ship a new build

The project already has `ios/App/App/App.entitlements` (`aps-environment`), `CODE_SIGN_ENTITLEMENTS` on both build
configurations, the AppDelegate hooks, and the plugin in `ios/App/CapApp-SPM/Package.swift` (from `npx cap sync ios`).

1. `npm run ios:sync`, then `npm run ios:open`.
2. In Xcode, target **App**, **Signing & Capabilities**: check **Push Notifications** is listed (add it with
   **+ Capability** if Xcode does not pick it up from the entitlements file). Automatic signing refreshes the
   provisioning profile with the push entitlement.
3. Archive and upload a new build to App Store Connect (TestFlight first). App Store and TestFlight builds are signed for
   the production APNs host automatically; a build run straight from Xcode uses the sandbox host. The Mac works out
   which one a device token belongs to on its own (tries production, then sandbox, and remembers).

### 4. On the phone

Open Settings in the app, Notifications, **Turn On Notifications**, and allow. The phone then registers with whichever
Mac it is connected to, and again on every connect, so each paired Mac gets it once you open that Mac in the app.

## What a notification carries

A project or tab name and a fixed phrase ("Tab 2 needs you", "api finished", "handed back a command to run", "New team
message from Brett"), or with **Show tab names** off only the event ("A tab needs you"). Never terminal text, a command,
a message body or a recap. Apple sees the APNs payload, so it carries no tab id either (tab ids contain the project
folder): a tap carries an opaque `ref` that only the Mac can turn back into the tab (`notifyResolve`, kept 24 hours),
plus the phone's own id for that Mac so the tap opens the right one. The collapse id is a hash.

## Token lifecycle

- Stored in config as `apnsTokens` `{ token, pairToken, pairingId, env, addedAt }`, at most 20, one per pairing.
- A token already held by another pairing that is still paired is refused (`token-in-use`), never moved: a paired phone
  cannot take over another phone's notifications. The app gives up a pairing's token itself when that Mac is removed
  in the app or the pairing is replaced by a new address for the same Mac.
- Sent only to tokens whose pairing is still paired, checked again before each request, and only while the news is
  still true (a prompt answered while an earlier phone's request waited is not sent to the next one).
- The collapse id is the notification's hashed tag plus the phone's id for this Mac, so two Macs never replace each
  other's notifications on one phone.
- Dropped on 410 / `Unregistered`, or `BadDeviceToken` from its known host (or from both hosts while unknown). A late
  answer for an older registration never removes a newer one (matched by `addedAt`).
- `ExpiredProviderToken` / `InvalidProviderToken`: a fresh JWT once, then the send fails and the token is kept.
- JWTs are reused for 40 minutes (Apple allows up to 60 and asks for no more than one new one every 20).

## Testing

`npm run test:apns` runs the JWT, the request and every outcome against a local HTTP/2 stand-in. Nothing in the test
suite or the harness ever calls api.push.apple.com; the two Apple hosts are constants in `electron/apns.js`.

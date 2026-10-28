# Multiple paired Macs

## Design

Store one versioned JSON document at `dobius-mobile-pairings-v1` through the existing Preferences/localStorage adapter: `{ version: 1, pairings: [{ id, origin, token, name, addedAt, lastUsedAt }], activeId }`. Normalize HTTP(S) origins before deduplication. Re-pairing replaces the token on the matching record while retaining its id, name and creation time. Rename, switch and remove are immutable updates, persisted serially. Removing the active record selects the most recently used remaining Mac.

Migration reads the new document first. If absent, read legacy `dobius-mobile-host` and `dobius-mobile-token` together, then write the complete document in one operation. Keep the legacy keys untouched: interruption before the write retries migration, and interruption after it reads the authoritative new document, including an intentionally empty list. A legacy browser token without a host can use the serving HTTP(S) origin; a bundled native app cannot infer a missing Mac address. Never silently overwrite an unreadable new document.

Every Connection snapshots one whole pairing. Authenticated REST, uploads, voice and push use its bound request method, with credentials omitted and redirects rejected. No global cached host or independent token lookup remains. Switching closes the old connection synchronously, detaches socket handlers, cancels timers, drops queued writes, aborts REST, then remounts the complete Mac screen tree with a fresh connection. Persisted drafts, board preferences and loose-end dismissals are namespaced by pairing id. History's request sequence remains module-scoped and monotonic; per-mount lists and response tracking reset. The requested `.dobius/NOTES.md` is absent from this worktree.

The board title opens a sheet listing Macs with switch, rename, remove and add actions. Add and QR/deep-link flows preserve the list. Scanned hosts still require the existing explicit human confirmation. Connection errors keep the switcher reachable, with retry and re-pair actions.

## CORS and transport

Inspected `bearerOk`, the REST routes and the WebSocket handshake in `electron/mobile-server.js`: protected REST routes require an explicit Authorization bearer token checked against paired devices. WebSockets require an explicit first auth frame with that token. Cookies, HTTP authentication and other ambient browser credentials do not authorize either path. `/health`, static assets and the rate-limited pairing-code exchange are intentionally public. CORS is not authentication and a Tailscale-looking hostname does not prove ownership.

Factor the origin allowlist into a pure function. Preserve native localhost origins and HTTP(S) localhost. Beyond those, an origin is allowed only when its host is one of THIS tailnet's own machines, read from `tailscale status --json` (`tailnetHostsFrom`: this Mac and every peer under the tailnet's own MagicDNS suffix that is not a ShareeNode, by DNS name, IPv4 and bracketed IPv6), refreshed every minute and cleared on stop. Neither a `*.ts.net` suffix nor the 100.64.0.0/10 range is enough: Tailscale Funnel serves public sites on `*.ts.net`, and a machine someone shares INTO the tailnet gets a 100.x address too. `POST /pair` answers with a full-control token, so either would let an attacker's page read one once the user typed a pairing code into it (reviewer findings, High, two rounds). Until the host list is known, only native and localhost origins pass. Reject credentials, paths, query strings, fragments, unsupported schemes and deceptive hostname suffixes. Do not enable credentialed CORS. Authenticated requests explicitly omit ambient credentials.

Detect an HTTPS page targeting an HTTP Mac before any request or socket. Explain the mixed-content block and offer the Mac's direct URL. Probe health before opening a connection so an older server's CORS rejection shows an update-Dobius+ message alongside connectivity guidance. Browsers do not distinguish a CORS rejection from a network failure, so the message must describe both possibilities.

## Push and voice

Each Mac has its own push service-worker registration scope and subscription, because different Macs have different VAPID keys. Preserve an existing same-origin subscription when its key matches. Never unsubscribe another Mac when switching. Notification routing carries the pairing id from the registration scope, including cold launches; legacy root-scope notifications resolve by the serving origin. Voice recording and requests stop on unmount, and all requests retain their connection's pairing snapshot.

## Validation

`test:multimac` is chained into `npm test`. Its 15 Node tests cover migration on both sides of the commit point, corrupt and failed storage, origin deduplication, removal, REST and socket credential binding, late socket frames, CORS boundaries, mixed content, voice cancellation on older iOS, separate VAPID subscriptions and notification routing with colliding tab ids. Existing connection tests now construct complete pairing inputs. The live-session fixture uses a relative executable path so temporary paths containing spaces work.

Validation keeps temporary data and npm's cache in `.dobius/multi-mac-tests/`. `TMPDIR` points to its `tmp-link` symlink, preserving the macOS temp-path property tested by account identity; `GIT_CEILING_DIRECTORIES` points to `.dobius/multi-mac-tests` so non-repository fixtures cannot discover this worktree. `DOBIUS_TEST_USERDATA` points to its `userdata` directory. The shared dependency installation's prebuilt node-pty helper lacked execute permission. An ignored, worktree-local copy has the helper permission repaired, with other dependencies still linked to the original installation.

Final checks: `npm test` exited 0, `npm run build:mobile` exited 0, and `npx eslint` on every changed file exited 0. Vite reported its existing large-chunk warning. ESLint has no configuration for Markdown, JSON or CSS, so those three files were reported as ignored; all changed JavaScript and JSX passed without errors or warnings. No Electron or app launch was performed.

## Unsure / for the reviewer

- Physical iOS and Safari testing is not available without launching the app, which this task prohibits. In particular, verify multiple push registration scopes on an installed iOS PWA.
- The browser cannot identify whether a failed cross-origin fetch is CORS, an unreachable Mac, or a rejected certificate. Diagnostics must not claim certainty.
- A legacy native token with no stored host cannot be safely bound to an inferred Mac. Preserve the legacy keys and ask for pairing.
- Accepted (review rounds): pairing changes and the startup migration run under a Web Lock across tabs, but Web Locks exist only in a secure context. On a plain-HTTP page two tabs saving within the same few milliseconds can still overwrite each other. iOS freezes background tabs, and HTTPS (Settings, Mobile Access) closes it.
- Accepted (review rounds): a notification displayed BEFORE the upgrade that carries no session (a failure notice) opens on whichever Mac is shown; nothing is sent to any terminal. Session notifications from before the upgrade route to the migrated Mac ('legacy') only, never by the serving origin.
- Accepted (review rounds): a tab still running the pre-upgrade build, left open across the upgrade, keeps its old in-memory behaviour until it reloads.
- Accepted (review rounds): a downgrade to a pre-multi-Mac build that pairs a DIFFERENT Mac (getting the root push subscription) and then upgrades again labels that Mac's notifications as the migrated one. An App Store install cannot downgrade, and the browser PWA always matches the Dobius+ version running on the Mac that serves it.
- Accepted (review rounds): if deleting the legacy single-Mac token fails AND the Mac's Dobius+ is downgraded before the new build loads again, the old build can use that token. Cleanup is retried on every launch of the new build.

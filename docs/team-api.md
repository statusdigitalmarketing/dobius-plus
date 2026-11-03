# Team communicator API

Design and threat model: `docs/team-communicator.md`. Code: `electron/team-*.js`.

## Phone server routes (tailnet, port 8420 by default)

Mounted before CORS and every body parser (`electron/team-routes.js`). All of them:

- require `Host:` to be this Mac's full MagicDNS name with the port (strict; else `421`);
- refuse any request carrying an `Origin` header (`403`) and never send CORS headers;
- pass admission before any body is read: per source IP at most 2 in flight and 30 a minute, 8 in flight overall
  (`429`), and the whole body within 5 s or the socket is destroyed;
- answer `404` while this Mac has no team identity (no secure storage).

### GET /team/hello?nonce=<32 hex>

Unauthenticated. Proves which keys answer at this address.

```json
{ "v": 1, "name": "Sam", "host": "sams-mbp.tail0.ts.net", "port": 8420, "ed": "<spki b64url>", "x": "<spki b64url>", "sig": "<ed25519 over dobius-team-hello|nonce|ed|x|name|host|port>" }
```

Errors: `400` bad nonce, `503` the phone server has no MagicDNS name yet.

### POST /team/link

`Content-Type: application/octet-stream` (else `415`), body at most 48 KB (`413`), header `x-dobius-team-sig`.
Body: `{ v, eph, nonce, ct }`, sealed to this Mac's X25519 key, holding `{ secret, name, host, port, ed, x, reqNonce }`,
signed by the joiner over the raw body.

| Status | Body | Meaning |
|---|---|---|
| 202 | `{ ok: true, state: "pending" }` | the person on this Mac has not decided; poll again |
| 200 | `{ ok: true, state: "accepted", conf }` | `conf` = this Mac's keys, name, host, port, signed over sha256(secret), joiner fingerprint, reqNonce and those fields |
| 403 | `{ ok: false, state?: "declined" \| "expired" }` | declined, expired, wrong secret, or the secret is already bound to other keys |

Side effects: the first valid request binds the invite to the joiner's keys and shows a notification plus an
Accept/Decline row in Settings > Team. Accept stores the joiner in `<userData>/team/peers.json`.

### POST /team/message

Same content type, size and signature header. Body `{ v, from, to, eph, nonce, ct }`; the sealed envelope is
`{ v, id, from, to, kind: ask|reply|note, replyTo, text (<= 8000), ts, firstSentAt, deadline }`.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ ok: true, receipt }` | accepted (or a retry of one already accepted); `receipt` is this Mac's signature over `dobius-team-ack|from|id|sha256(kind|replyTo|text)` |
| 403 | `{ ok: false }` | unknown or disabled sender, bad signature, not for us, stale `ts`, `firstSentAt` outside [now-6d, now+5min], bad fields |
| 409 | `{ ok: false }` | same sender and id with different content |
| 429 | | rate limited (admission, or 20/min and 300/day per teammate) |
| 503 | `{ ok: false }` | "Accept team messages" is off; the sender keeps retrying |

Side effects: the message is stored in `<userData>/team/messages.json`, a notification is shown, and it is typed into
the pinned orchestrator tab when Auto-route is on for the sender (else it waits in Tasks > Team).

## Loopback bridge (127.0.0.1:8421): POST /team

The bridge's usual rules (loopback, exact Host, no Origin, JSON, `Authorization: Bearer <bridge token>`). Used by
`dobius-team` in `<userData>/bin`.

```json
{ "cmd": "peers" | "inbox" | "send" | "reply", "arg": "<name|fingerprint>" or "<message id>@<sender fingerprint>", "text": "...", "tabId": "$DOBIUS_TAB_ID" }
```

Reply: `{ ok: true, lines: ["..."] }` or `{ ok: false, error }`. `send` and `reply` are refused (`403`) unless
`tabId` is the pinned orchestrator tab (a guard against a stray session, not a security boundary). `reply` needs the
`id@fingerprint` form the card and `dobius-team inbox` print: ids are unique only per sender.

```bash
dobius-team peers
dobius-team inbox
dobius-team send Bryan <<'EOF'
where does the Axiom catalog stand?
EOF
dobius-team reply 0123abcd-4567-4890-8abc-0123456789ab@<sender fingerprint> <<'EOF'
live since this morning
EOF
```

## IPC (renderer)

`team:status`, `team:messages`, `team:invite`, `team:join`, `team:decideLink`, `team:send`, `team:reply`,
`team:retry`, `team:sendAgain`, `team:routeNow`, `team:updatePeer`, `team:unlink`, `team:settings`; event
`team:changed`. Exposed in preload as `window.electronAPI.team*`.

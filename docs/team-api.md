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

### POST /team/status (lifecycle reports, 2026-11-06)

From the Mac that RECEIVED a message to its sender. Same envelope and checks as `/team/message`: octet-stream body
`{ v, from, to, eph, nonce, ct }` sealed to the sender (purpose `status`, AAD `dobius-team-status|1|from|to|eph|nonce`),
signed by the reporter in `x-dobius-team-sig`. Sealed inner:

```json
{ "v": 1, "from": "<reporter fp>", "to": "<sender fp>", "id": "<the sender's message id>", "seq": 3,
  "state": "held|needs attention|read|working|replied|done|failed|stopped", "at": 1790000000000,
  "note": "<= 300 chars or null", "replyId": "<uuid of the reply> or null", "ts": 1790000000000 }
```

| Status | Body | When |
|---|---|---|
| 200 | `{ ok: true, ack }` | valid; `ack` = sender's signature over `dobius-team-status-ack|reporter|id|seq`. Applied only to the sender's own outgoing row for (reporter, id) when `seq` is newer; acked either way |
| 403 | `{ ok: false }` | unknown or disabled reporter, bad signature, not for us, sealed body, fields, stale `ts` (> 5 min) or `at` |

The reporter stops only on a verified ack; any other answer is retried with back-off until 24 h after the event.

## Loopback bridge (127.0.0.1:8421): POST /team

The bridge's usual rules (loopback, exact Host, no Origin, JSON, `Authorization: Bearer <bridge token>`). Used by
`dobius-team` in `<userData>/bin`.

```json
{ "cmd": "peers" | "inbox" | "show" | "send" | "reply" | "approve" | "release" | "done" | "failed", "arg": "<name|fingerprint>" or "<message id>@<sender fingerprint>" or "<request id>", "text": "...", "tabId": "$DOBIUS_TAB_ID" }
```

Reply: `{ ok: true, lines: ["..."] }` or `{ ok: false, error }`. With no orchestrator tab pinned, `send`, `reply` and
`approve` are refused (`403`). From the pinned tab, `send` and `reply` queue the message. From any other `tabId`
they send nothing: the request is checked (`400` with the reason if it is not sendable), then typed into the pinned
tab as a card ending `dobius-team approve <request id>`, and the reply says `handed to the team orchestrator tab
(request <id>) ... Not sent yet.` `approve` is accepted only from the pinned tab (`403` otherwise) and sends the stored
request exactly once (`400`: unknown, expired after 24 h, or already sent). The tab check is a guard against a stray
session, not a security boundary. `reply` needs the `id@fingerprint` form the card and `dobius-team inbox` print: ids
are unique only per sender.

```bash
dobius-team peers
dobius-team inbox
dobius-team send Bryan <<'EOF'
where does the Axiom catalog stand?
EOF
dobius-team reply 0123abcd-4567-4890-8abc-0123456789ab@<sender fingerprint> <<'EOF'
live since this morning
EOF
dobius-team approve Xy3_aB9kLm0q   # orchestrator only: send a request another tab handed over
dobius-team show 0123abcd-4567-4890-8abc-0123456789ab@<fingerprint>      # timeline of one message
dobius-team release 0123abcd-4567-4890-8abc-0123456789ab@<fingerprint>   # orchestrator only: type a held message in now
dobius-team done 0123abcd-4567-4890-8abc-0123456789ab@<fingerprint>      # orchestrator only: tell the sender it is done
echo "staging is down" | dobius-team failed 0123abcd-4567-4890-8abc-0123456789ab@<fingerprint>
```

`inbox` lines read `<id>@<fp>  -> Brett  [read 3m] (note)  <text>`: the stage (an outgoing message's last report from
the teammate, else its own state), how long it has been there, and the reason when there is one.

## IPC (renderer)

`team:status`, `team:messages`, `team:invite`, `team:join`, `team:decideLink`, `team:send`, `team:reply`,
`team:retry`, `team:sendAgain`, `team:routeNow`, `team:updatePeer`, `team:unlink`, `team:settings`; event
`team:changed`. Exposed in preload as `window.electronAPI.team*`.

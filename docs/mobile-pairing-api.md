# Phone server: pairing endpoints

The phone server (`electron/mobile-server.js`) listens on the Mac's tailnet IP only, on `mobileServer.port` (default 8420). It answers plain HTTP and, when a Tailscale certificate exists, HTTPS on the same port.

Every request must carry a `Host` this Mac owns, or it gets `421` before any route runs (DNS rebinding guard, `isOwnHost` in `electron/mobile-cors.js`):

- the tailnet IP, the full MagicDNS name, or the short machine name, at the port
- any tailnet IP literal (100.64.0.0/10) at the port: a Mac shared to another tailnet is reached at a translated address
- on port 80 or 443, the same without the port

`/pair` is stricter: it refuses the short machine name, since a phone's DNS search domain can repoint it.

## POST /pair

Exchanges the six-digit pairing code shown in Settings for a device token.

- Auth: none (the code is the secret). Wrong guesses lock pairing for a minute after a flood.
- Request: `{ "code": "123456", "deviceName": "Phone" }`
- Response `200`:

```json
{ "ok": true, "token": "<64 hex>", "name": "Sams-MacBook-Pro", "hosts": ["100.89.143.67", "sams-macbook-pro.tail6addbf.ts.net", "sams-macbook-pro"] }
```

`hosts` lists this Mac's own addresses. The phone only runs the same-Mac check below against saved pairings at one of them.

- Errors: `403` wrong code or pairing locked, `429` cooling down, `421` foreign or short-name Host.
- Side effects: adds a device to `config.mobileServer.devices`.

```bash
curl -s -X POST http://100.89.143.67:8420/pair -H 'Content-Type: application/json' -d '{"code":"123456","deviceName":"Phone"}'
```

## POST /same-mac

Lets a phone prove that an older saved address (for example the HTTP IP it paired before HTTPS came on) is this same Mac, without sending that address's token anywhere. The phone then keeps one record instead of two.

- Auth: `Authorization: Bearer <token just issued by /pair>`
- Request: `{ "tokenHash": "<sha256 hex of the OLD saved token>", "nonce": "<64 hex, random>" }`
- Response `200`: `{ "ok": true, "proof": "<HMAC-SHA256(old token, nonce) hex>" }`. The phone computes the same HMAC itself and merges only on an exact match.
- Errors: `401` missing or unknown bearer, `400` malformed hash or nonce, `404` this Mac never issued a token with that hash (a different Mac at a reused IP lands here).
- Side effects: none.

Only a server holding the old token can produce the proof. A server that relays the request to the real Mac fails the bearer check there, since the bearer is its own token.

```bash
NONCE=$(openssl rand -hex 32)
HASH=$(printf %s "$OLD_TOKEN" | shasum -a 256 | cut -d' ' -f1)
curl -s -X POST https://sams-macbook-pro.tail6addbf.ts.net:8420/same-mac \
  -H "Authorization: Bearer $NEW_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"tokenHash\":\"$HASH\",\"nonce\":\"$NONCE\"}"
```

A plain-HTTP browser page has no WebCrypto, so it skips this check and keeps both records. The native app always has it.

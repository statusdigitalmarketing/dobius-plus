# Mobile WebSocket: tab writes and their answers

The phone app, and local tools such as the dobius-supervisor skill, drive
Dobius+ terminal tabs over the mobile server's WebSocket. This page covers the
handshake and the three requests that write to a tab (or authorize writing to
one), which are answered from v1.0.88. Pairing and the HTTP side are in
`mobile-pairing-api.md`.

Code: `electron/mobile-tab-ops.js` (rules), `electron/mobile-server.js`
(wiring), `electron/chat-service.js` (the write queue).
Tests: `npm run test:tabops`.

## Connecting

- URL: `ws://<host>:<port>/ws` or `wss://<host>:<port>/ws`. HTTP and HTTPS share
  one port. `<port>` is `mobileServer.port` in the app's `config.json` (8420 by
  default). The Host header must name this Mac (its tailnet IP or MagicDNS name).
- Auth: the first frame must be `{"type":"auth","token":"<device token>"}`,
  within the auth timeout. A token is a paired device's
  `mobileServer.devices[].token`. A bad token closes the socket with code 4003.
- Reply:

```json
{ "type": "authed", "version": "1.0.88", "features": ["ack"] }
```

`features` is new in v1.0.88. A server whose `authed` lacks `"ack"` (v1.0.87
and older) answers NONE of the requests below: a client talking to one cannot
confirm delivery and must say so (the supervisor reports `unconfirmed`).

## Requests

Every request may carry an optional `reqId`: a string of 1 to 64 characters or
a safe integer. It is echoed in the reply so a client with several requests in
flight can match them. Anything else in `reqId` is refused as `bad_request`
(and not echoed).

| Request | Fields | Acked when |
|---|---|---|
| `authorizeTab` | `id` | the tab is live; this socket may now send input, resize and kill to it |
| `input` | `id`, `data` (raw keys, non-empty) | the keys are written to the PTY (after any submit queued ahead of them) |
| `submitPrompt` | `id`, `text` (not blank) | the text is pasted AND the discrete Enter after it is written |

What an ack proves: the bytes were handed, in order, to the tab's PTY writer
(the same point the desktop terminal's own typing reaches). node-pty moves them
into the kernel's tty buffer asynchronously, and nothing at the PTY level can
say whether the program in the tab READ them: a tab that exits while its
foreground process is not reading stdin loses whatever is still buffered,
acked or not. An ack rules out the dropped-request class (wrong id, not
authorized, refused, tab gone before the write); it is not proof the agent saw
the text. Read the tab back when that matters.

`id` is the FULL tab id, as `listTerminals` returns it, for example
`term-/Users/sam/Projects (Code)/better-telehealth-83`. A socket must authorize
a tab (`authorizeTab`, `attach`, `createTerminal`, `selectorSnapshot`,
`terminalText` or `loadTranscript` for it) before `input` or `submitPrompt`.

## Replies

Success:

```json
{ "type": "ack", "op": "submitPrompt", "id": "term-/Users/sam/Projects (Code)/better-telehealth-83", "reqId": "r1" }
```

Refusal:

```json
{
  "type": "opError", "op": "submitPrompt", "code": "unknown_tab",
  "id": "better-telehealth-83", "reqId": "r1",
  "message": "No live tab has that id",
  "candidates": ["term-/Users/sam/Projects (Code)/better-telehealth-83"]
}
```

`id` is the id the request named (null when it was not a string); in an ack it
is the full id that was written to. `reqId` is null when the request had none.
`message` is for people; match on `code`.

The refusal type is `opError`, not `error`: the phone's Board and Terminal
screens treat every `error` frame as a failed create (an alert, and the create
guard released), and phones on an older cached bundle would do that for every
refused keystroke. Clients ignore message types they do not know, so `ack` and
`opError` are invisible to them.

| code | Meaning | Written? |
|---|---|---|
| `bad_request` | `id`, `data`/`text` or `reqId` has the wrong type, or `reqId` is too long | no |
| `unknown_tab` | no live tab has exactly this id; see `candidates` | no |
| `not_authorized` | the tab is live but this socket has not authorized it | no |
| `empty_text` | `data` is empty, or `text` is blank | no |
| `too_large` | over 100 KB in UTF-8 bytes | no |
| `revoked` | the device was unpaired while the write was queued | no |
| `tab_exited` | the tab closed, exited or was replaced before the write | no, or (submit) the paste went out but no Enter |
| `cancelled` | a cancel key (Ctrl+C, Ctrl+U, Esc) dropped or erased it | no, or erased |
| `stranded` | submit only: pasted, but Enter was withheld because something else typed into the tab meanwhile. The text sits in the input line | pasted, not submitted |
| `write_failed` | an unexpected failure in the write path | unknown |

### Short ids are never guessed

`unknown_tab` carries `candidates`: up to 5 live full ids whose last path
segment equals the requested id (or the requested id minus a leading `term-`).
The server never writes to a candidate, even when there is exactly one: two
projects can share a final folder name, and typing a prompt into the wrong
project's Claude is far worse than an error. A client that wants the shortcut
can retry with the full id itself, after deciding the match is right. The list
discloses nothing new: the same socket can already read every live id with
`listTerminals`.

## Examples

Node, with `ws`:

```js
const ws = new WebSocket(`ws://${host}:${port}/ws`);
ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'authed') {
    if (!m.features?.includes('ack')) console.log('old server: delivery cannot be confirmed');
    ws.send(JSON.stringify({ type: 'authorizeTab', id, reqId: 'auth-1' }));
    ws.send(JSON.stringify({ type: 'submitPrompt', id, text: 'keep going', reqId: 'send-1' }));
  }
  if ((m.type === 'ack' || m.type === 'opError') && m.reqId === 'send-1') {
    console.log(m.type === 'ack' ? `delivered to ${m.id}` : `refused: ${m.code}`, m.candidates ?? '');
    ws.close();
  }
});
```

From the shell, with websocat:

```sh
printf '%s\n' '{"type":"auth","token":"<token>"}' \
  '{"type":"authorizeTab","id":"better-telehealth-83","reqId":1}' \
  | websocat -n1 "ws://100.x.y.z:8420/ws"
# {"type":"authed","version":"1.0.88","features":["ack"]}
# {"type":"opError","op":"authorizeTab","code":"unknown_tab","id":"better-telehealth-83","reqId":1,...}
```

## Side effects

- `input` of 4 characters or fewer, and every accepted `submitPrompt`, push a
  fresh `selector` message 700 to 900 ms later (the write may have answered a
  prompt). Refused requests push nothing.
- An accepted write clears the tab's pending selector push.
- The phone's Chat view shows a short note for a refused chat send
  (`unknown_tab`, `tab_exited`, `not_authorized`, `too_large`, `cancelled`,
  `stranded`); its Terminal screen refreshes the tab list on `unknown_tab`.

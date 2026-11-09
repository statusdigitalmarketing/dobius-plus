# Bridge `POST /tabSend` (dobius-send)

Sends a message into an EXISTING tab on this Mac and submits it. Code: `electron/tab-send.js` (decisions),
`electron/voice-bridge.js` (route and the `dobius-send` script), wiring in `electron/main.js` (`setTabSendService`).
To open a NEW tab and send it a message, use `/openTab` (`docs/bridge-open-tab.md`).

## Endpoint

`POST http://127.0.0.1:8421/tabSend` (the bridge port; `DOBIUS_BRIDGE_PORT` moves it for an isolated instance)

## Authentication

- `Authorization: Bearer <token>`, the bridge token in `<userData>/voice-bridge-token` (0600).
- `Host: 127.0.0.1:<port>` exactly (DNS rebinding guard).
- The scripts put the token in a private header file, never on a command line.

## Request

| Field | Type | Required | Description |
|---|---|---|---|
| `tabId` | string | yes | The full tab id from `dobius-tabs` (`term-/path/to/project-N`). |
| `message` | string | yes | The text. Any length the bridge accepts, line breaks included. |

## What happens, by what is in the tab

| The tab holds | What is done | Reply |
|---|---|---|
| Claude at an empty prompt, idle or working | One bracketed paste, then Enter as its own write, on a screen read while nothing new arrived and nobody used the tab, with the box holding the message, Claude still in front (no command of its reading the terminal) and no permission prompt open. Then the box must empty. While Claude works it queues the message for after the turn, and `note` says so. | `{ ok: true, sent, submitted: true, confirmed: true }` |
| Claude, but the Enter only added a line, could not be pressed, or the tab closed before the box emptied | Nothing more is pressed. | `{ ok: false, sent, typed: true, submitted: false, note }` (200) |
| Claude with a draft in its box | Nothing typed. | 409 `{ ok: false, error }` |
| Claude with a question or dialog open | Nothing typed (an Enter would answer it). | 409 |
| Claude running a command that holds the terminal readable | Nothing typed (keys could reach that command). | 409 |
| The process checks failed (a ps or pgrep timeout) | Nothing typed: a failed check is never read as "not Claude". | 409 |
| The process checks say "not Claude" but the screen shows Claude's prompt | Nothing typed (a check can time out into "no"). | 409 |
| Claude, with a screen that never held still for 3 s | Nothing typed. | 409 |
| A message to Claude ending in a backslash | Nothing typed (Claude reads backslash + Enter as a new line). | 409 |
| Another send to the same tab still running, or dobius-open still delivering its message there | Nothing typed. | 409 |
| Someone typing into the tab right now | Nothing typed. | 409 |
| Not Claude (a shell, Codex, another program) | Typed in chunks of 256 characters, then Enter as a separate write after a pause; nothing goes out when someone typed during the checks, and no Enter when someone typed during the pause. | `{ ok: true, sent, submitted: true, confirmed: false, note }`; 409 with `typed: true` when Enter was held back |
| No such tab | Nothing. | 404 |

A tab opened from the phone counts like any other. A tab whose dot is red only because Claude handed back a `! command`
is at an ordinary prompt and is sent to; a real permission prompt is not.

`ok` is true only when Enter was pressed on the message and, in a Claude tab, Claude was seen taking it. `confirmed`
says whether it was seen (false only for a tab that is not running Claude).

Why it changed (2026-11-09, a bug report from another Mac): the old route wrote the message in raw chunks with `\r`
straight behind them. Claude read the burst as a paste, so the Enter landed inside it as a new line; a long or
multi-line message then sat unsent while the reply said ok.

## Response examples

```json
{ "ok": true, "sent": 2726, "submitted": true, "confirmed": true }
```

```json
{ "ok": false, "error": "Claude's prompt in that tab already holds typed text; nothing was typed" }
```

## curl

```bash
HDR=$(mktemp); chmod 600 "$HDR"; trap 'rm -f "$HDR"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$HOME/Library/Application Support/dobius-plus/voice-bridge-token")" > "$HDR"
curl -sS --noproxy '*' -X POST http://127.0.0.1:8421/tabSend -H "Host: 127.0.0.1:8421" -H @"$HDR" \
  -H 'Content-Type: application/json' -d '{"tabId":"term-/path/to/project-2","message":"hello"}'
```

Or `dobius-send <tabId> "<message>"`: it prints the reply and exits 0 only when `ok` is true, 1 when the reply says (or the arguments are missing)
otherwise, 2 when the bridge did not answer or its token could not be read, 3 when python3, curl or a temp file is
missing.

## Side effects

Writes to the tab's terminal only. Nothing is logged with the message text.

## `dobius-tabs` status

`/tabList` now returns each tab's `status` (`working`, `done`, `needs`, `idle`, or null when unknown, from the tab
status dots), and `dobius-tabs` prints it as the last column.

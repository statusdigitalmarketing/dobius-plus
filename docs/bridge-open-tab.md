# Local bridge: POST /openTab

Opens a new, visible Dobius+ tab in a project, starts Claude in it, waits until Claude's prompt is really on screen, types a message into the prompt, and presses Enter once so Claude starts on it right away. Built for an inbox board (an email, text or Asana card) that hands work to Claude: the click on the card is the OK, so nothing asks for a YES. Claude runs with your normal settings and permission mode.

Because the message is sent to Claude without a second look, treat card text as a prompt you are giving Claude: an email can contain instructions. Claude's permission prompts are what stand between those instructions and a change on disk, and in bypass permissions mode there are none (see Security).

Code: `electron/bridge-open-tab.js` (validation, message cleaning, readiness check, dedupe), `electron/bridge-open-main.js` (windows, PTY, screen), route in `electron/voice-bridge.js`. Tests: `electron/__tests__/bridge-open-tab.test.mjs`.

## Endpoint

`POST http://127.0.0.1:8421/openTab`

The bridge binds 127.0.0.1 only. Every route, this one included, requires:

| Check | Fails with |
|---|---|
| Source address is loopback | `403` |
| `Host` is exactly `127.0.0.1:8421` (DNS rebinding guard) | `421` |
| No `Origin` header (any browser page sends one) | `403` |
| `Content-Type: application/json` (forces a CORS preflight the bridge never answers) | `415` |
| `Authorization: Bearer <token>` matching the token file | `401` |

The token is the same one the `dobius-*` scripts use: `~/Library/Application Support/dobius-plus/voice-bridge-token` (mode 0600, readable only by the Mac user). A web page cannot read it, cannot send a non-loopback `Host` that passes, and cannot drop `Origin`, so a page cannot open tabs or type into Claude.

## Request

JSON body, at most 64KB:

| Field | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | yes | Absolute path of the project folder. Must exist, be a directory, and be a project Dobius+ already knows (see below). Symlinks are resolved. |
| `message` | string | yes | The text to type into Claude's prompt. At most 32768 bytes (UTF-8). |
| `requestId` | string | yes | The caller's id for this click. 1-128 characters, letters, digits and `. _ : -`, starting with a letter or digit. |

### Which folders are accepted

Only a project Dobius+ already lists: a folder with an open window, one in the launcher's projects folder, a manually added project, or one with Claude sessions. Matching is by real path, and the project's known spelling is used, so a symlinked path reuses the window already open for that project. Any other folder is refused with `403`. A bad card or a typo must not open Claude in `~`, `/` or an arbitrary folder, or create window state for it. To use a new folder, open it once from the launcher (or keep it in the projects folder).

### What happens to the message

It is typed as ONE bracketed paste, which Claude treats as pasted text, never as keys:

- Line breaks are kept as line breaks inside the prompt. `\r\n` and a lone `\r` become `\n`, so nothing in the text can act as Enter. The one Enter that sends the message is pressed by Dobius+ separately (step 7).
- Escape sequences are removed whole (an embedded `ESC[201~` would otherwise end the paste early and let the rest drive Claude as keystrokes), then every other control character except tab and newline is dropped (Ctrl+C, Ctrl+U, DEL, C1 controls).
- A message that is empty after this is refused.

## What it does

1. Validates the body and the folder.
2. Opens the project's window if it is not open, otherwise uses its first window, and brings it to the front.
3. Asks that window for a New Tab that starts **Claude**, whatever the "New Tab Starts" setting says (Claude, Codex or a plain shell): the same path as the New Tab menu with Claude picked (`store.openNewTab(project, 'claude')`). The tab is shown. Its shell is spawned by the window like every other tab, with the active Claude account's environment and the project folder as its working directory.
4. The tab's login shell starts `claude` itself as its first command (`terminal:create` with launch `claude`, mapped through the fixed allowlist in `shared/new-tab.js`). Nothing is typed to start it. No flags are added, so Claude runs with your normal settings and permission mode. If a login script keeps the terminal busy, starts something else, or changes directory, Claude does not come up in the project as the foreground program and the call ends at step 5 with `504`, nothing typed.
5. Waits until Claude is ready. Three things must hold on two checks in a row (polled every 250ms, for up to 60 seconds):
   - the tab's output since it started, replayed through the headless terminal emulator, shows Claude's prompt box (a rule, the `❯` row, a closing rule) within the bottom 12 rows of what is drawn;
   - the program turned bracketed paste on;
   - a `claude` process leads the foreground process group of THIS tab's terminal and works in the project folder, recognised by the executable the system actually ran: a claude entrypoint that exists on disk, or node/bun/deno running one (so `node other.js /path/to/claude`, or a program in a folder named `claude tools`, does not count). A shell at its prompt, a suspended or background claude, or anything else fails closed;
   - no output arrived between reading the screen and the process check (Claude exiting and the shell redrawing would show up there).
   A trust question, a login screen, a permission prompt or any selector does not count as ready, even if it quotes something that looks like the prompt box. Claude's permission mode is not checked: the card is sent in every mode (see Security).
6. Pastes the message as one bracketed paste, in the same tick as that last check, so nothing can change in between. Not if a person has typed into the tab (keyboard, paste or a Chat message; moving the mouse does not count): then `409` and nothing is typed, because their own Enter could still be on its way and would carry the card's text.
7. Presses Enter, once, as its own write, unless the message starts with `!`, `/`, `#` or `&` (Claude reads those as a shell command, a slash command, a memory note or a background task, and `!` runs with no permission prompt): those are typed but never sent automatically, and neither is a message ending in a backslash (Claude reads backslash + Enter as a new line). Otherwise it presses Enter only after Claude has visibly taken the paste (it redrew, then went quiet for 300ms; at most 5 seconds) and only if, checked again right before: Claude is still the foreground process, its prompt box is on screen and holds exactly the message (the same text, whitespace aside, or only Claude's "[Pasted text #1 +N lines]" marker with this card's line count; anything else in the box, such as a recalled history entry, stops the Enter), no dialog or selector is on screen (an Enter would answer it), nothing was drawn since that check began, and nobody typed into the tab or used the mouse in it since the paste (a wheel turn can recall history into the box). After the Enter, Dobius+ checks that Claude took the message (its input box is seen without it, and nobody typed or used the mouse meanwhile); if the message is still sitting there (for example Enter is set to insert a new line) the reply says `"submitted": false`. If any check before the Enter fails, the Enter is NOT pressed: the reply is `200` with `"submitted": false` and a `note` saying why, and the message waits in Claude's prompt for you to press Enter.

The reply is sent after step 7 (or with the reason it stopped). Allow about two minutes: a cold window plus a Claude startup can take a while. `dobius-open` waits up to 180 seconds.

## Repeats (requestId)

- The same `requestId` while its tab still exists brings that tab and its window to the front and replies with the same `tabId` and `"existing": true`. Nothing is typed or sent again.
- Two calls with the same `requestId` at the same time open one tab: the second waits for the first and gets the same outcome, a failure included.
- The same `requestId` with a different `projectPath` is refused with `409`.
- If that tab has been closed (or its shell has exited), a later call with the same `requestId` opens a new tab.
- A call that failed before any tab existed is forgotten, so it can simply be retried.
- The last 500 ids are remembered, in memory only (a restart forgets them).

At most 4 different requests may be opening at once; more get `429`.

## Response

Success, `200`:

```json
{ "ok": true, "tabId": "term-/Users/brett/Projects/acme-7", "submitted": true }
```

Typed but not sent (see step 7), `200`:

```json
{ "ok": true, "tabId": "term-/Users/brett/Projects/acme-7", "submitted": false, "note": "the message is typed into Claude's prompt but was not sent: someone typed into the tab; press Enter in the tab to send it" }
```

Repeat of a live request, `200`:

```json
{ "ok": true, "tabId": "term-/Users/brett/Projects/acme-7", "existing": true }
```

Failure:

```json
{ "ok": false, "error": "why it could not open it" }
```

When a tab was opened but the message could not be typed, `tabId` is included too.

## Errors

| Status | When |
|---|---|
| `400` | Body is not JSON, bad `requestId`, `projectPath` not absolute / not a directory / has control characters, `message` missing, empty after cleaning, or over 32768 bytes |
| `401` | Missing or wrong token |
| `403` | Folder is not a project Dobius+ knows; or the request carried an `Origin` (browser) or did not come from loopback |
| `404` | Folder does not exist |
| `409` | `requestId` already used for another project; or the tab was closed, its shell exited or was replaced, or someone typed into it, before the message could be typed. Nothing was typed. `tabId` included in the second case |
| `415` | `Content-Type` is not `application/json` |
| `421` | `Host` is not `127.0.0.1:<port>` |
| `429` | 4 opens already in progress |
| `500` | The window, the tab or its shell did not start, or the shell did not start in the project folder (`tabId` included when the tab exists) |
| `503` | Dobius+ is still starting |
| `504` | Claude's prompt did not appear within 60 seconds (or Claude is not the foreground program in the project: a login script got in the way). The tab stays open, nothing was typed. `tabId` included. A repeat of the same `requestId` brings that tab forward |

## Security

- **Who can call it.** Only a local process that can read the bridge token file (the Mac user's own processes). A web page cannot: no token, wrong `Host`, an `Origin` header, and the JSON content type forces a preflight the bridge never answers.
- **Auto-send is deliberate.** An automated security review rated "a token holder can submit a prompt to Claude" HIGH. It was kept: the requester asked for the message to be sent, and `/tabSend` with the same token already writes a message plus Enter into ANY tab, plain shells included. `/openTab` adds no capability the token did not have, and it is narrower: it only ever types into a tab it just opened, only after verifying `claude` is that tab's foreground process, and Claude keeps whatever permission mode the session is in (next point).
- **Permission modes: the card is sent in every mode, by the owner's decision.** Sam: "bypass permissions should act just like auto mode". So whatever mode the session is in (default, accept edits, auto, plan, or bypass permissions, from your settings or your own Shift+Tab), the card is sent the same way. In default, accept-edits and auto mode Claude still asks (or, in auto mode, its classifier decides) before acting. **In bypass permissions mode a sent card runs with no permission prompts at all: the card's contents, which may come from an email someone else wrote, are acted on directly.** That is Sam's explicit choice. Dobius+ itself never adds a permission-skipping flag: the launch is plain `claude`, and the mode comes only from your own settings or your own toggling.
- **What /openTab still refuses.** The message is a prompt, and an email can contain instructions. Nothing here answers Claude's questions (permission prompts, trust, login). A message starting with `!` (Claude's shell mode), `/`, `#` or `&` is never sent automatically, in any mode: those change what Claude does with the text, not just whether it asks.
- **Known limit (shells).** Claude is started by the New Tab launcher, which drives zsh and bash only. With another login shell (fish, say) the tab opens a plain shell, Claude never comes up, and the call returns `504` with nothing typed.
- **Known limit.** A message whose first line starts like a numbered option (`1. Fix the README`) looks like a selector once it is in the prompt, so it is typed but not sent (`submitted: false`).
- **Keystroke safety.** The message cannot carry an Enter, Ctrl+C, an escape sequence or any other control character (see "What happens to the message"); the single Enter is written separately by Dobius+ after the checks in step 7.

## Side effects

- May open a project window, and always brings the window to the front.
- Adds one tab to that window (saved with its tabs like any other); its shell starts `claude`.
- Types the message into Claude's prompt and presses Enter once to send it (unless a check fails, see step 7). Never answers any question Claude asks: permission prompts, the trust question and logins are left to you.
- Sends no texts or notifications.

## curl

```bash
TOKEN=$(cat "$HOME/Library/Application Support/dobius-plus/voice-bridge-token")
curl -sS --max-time 180 -X POST http://127.0.0.1:8421/openTab \
  -H "Host: 127.0.0.1:8421" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectPath":"/Users/brett/Projects/acme","requestId":"gmail-18c2f0a9","message":"Reply to Dom about the Q3 invoice.\nSay we pay on the 15th."}'
```

## dobius-open

Dobius+ installs a helper script that does the same call (to `~/.local/bin/dobius-open`, and to its own `bin` folder that every tab has on its PATH):

```bash
dobius-open /Users/brett/Projects/acme gmail-18c2f0a9 "Reply to Dom about the Q3 invoice."
dobius-open /Users/brett/Projects/acme asana-1209 - < card.txt   # message from stdin
```

It prints the JSON reply and exits 0 only when it says `ok`. The token never appears on a command line. A message passed as an argument does (any local user can read it with `ps` while the command runs), so pass anything private on stdin with `-`; Brett's board should call the HTTP endpoint directly.

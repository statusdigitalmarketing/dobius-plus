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

`uncertain: true` (present only when set) means the text reached the tab but
the server did not finish the write: the paste went out and its own Enter was
withheld (something else reached the tab during the paste delay, or the tab
went away), or the write threw part way. The text may be sitting in the input
line, or something else (another writer, a person pressing Enter later) may
submit it. Treat it as UNKNOWN delivery, never as "not sent": read the tab back
before resending. Requests queued behind a failed write that were never
touched get `write_failed` WITHOUT `uncertain`: they are plainly unsent.

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
| `tab_exited` | the tab closed, exited or was replaced before the write | no; after a paste, `uncertain` |
| `cancelled` | a cancel key (Ctrl+C, Ctrl+U, Esc) dropped or erased it | no, or erased |
| `stranded` | submit only: pasted, but Enter was withheld because something else reached the tab meanwhile (always `uncertain`) | pasted, maybe submitted |
| `write_failed` | an unexpected failure in the write path | `uncertain` if this request had started writing, else no |

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
- The phone's Chat view tags each chat send with a `reqId` and shows a short
  note when THAT send is refused (`unknown_tab`, `tab_exited`,
  `not_authorized`, `too_large`, `cancelled`), or "Maybe sent" for any
  `uncertain` refusal; its Terminal screen refreshes the tab list on
  `unknown_tab`.

## Today and Settings (2.2.4)

Advertised as `today` and `settings` in `authed.features`. A phone must check
for them: an older Mac ignores these message types and never answers. Code:
`electron/mobile-today.js` (handler and settings allowlist), wired in
`electron/main.js` (`setTodayBridge`), which hands in the same functions the
desktop IPC uses. Auth is the normal phone bearer token; nothing else.

Every request carries a string `reqId` (at most 64 characters) and the reply
echoes it. A failure says only `error` (a fixed code), never board text. These
writes are NOT queued by `mobile/connection.js` across a reconnect: the phone
says "No answer" and the person taps again.

| Request | Fields | Reply |
| --- | --- | --- |
| `todayRead` | | `{type:'today', ok, data}`: `readToday()` without the board's loopback `url`. `data.board` has `state`, `mode` (`claude`/`rules`), `picking`, `pickedAt`, `today` (YYYY-MM-DD), `suggested[]` (cards with `reason` and `print`), `snoozed[]` (`id, subject, who, source, until, print`), `otherCount`, `total`, `failing[]`; `data.noticed` is the SamKnows hint list |
| `inboxRead` | | `{type:'inbox', ok, data}`: every open card, each with `print` |
| `todaySnooze` | `id`, `choice` (`tomorrow`/`week`), `print` | `{type:'todayResult', op:'snooze', id, ok, changed}`; `changed:true` when the card is no longer the version the phone showed |
| `todayUnsnooze` | `id`, `print` (the snoozed row's) | `{type:'todayResult', op:'unsnooze', id, ok}`; refused when the snooze is of a newer version |
| `inboxAct` | `kind` (`done`/`complete`/`undo`), `id`, `rev`, `print` (not for undo) | `{type:'todayResult', op, id, ok, changed, reason}`. `complete` closes an Asana task in Asana; the phone asks first |
| `settingsRead` | | `{type:'settings', ok, data:{todayNudges, newTabTool, autoMode, info:{version, account, imessageReady, phonePush}}}` |
| `settingsWrite` | `key`, `value` | `{type:'settingsResult', key, ok, error}` |

`settingsWrite` keys (anything else is `not-allowed`):

- `todayNudges`: a partial `{imessage, mac, push: boolean, morningAt, quietAfter: 'HH:MM'}`,
  merged and checked as a whole: morning 05:00 to 12:00, quiet at least two
  hours after morning (`quiet-before-morning`, `bad-time`).
- `newTabTool`: `claude`, `codex` or `shell`.
- `autoMode`: boolean.

Pushed to every authed phone, with no content: `{type:'todayChanged'}` after a
snooze, Bring back or Done from any device, and `{type:'settingsChanged'}` after
any settings write. An open screen reads again.

```sh
printf '%s\n' '{"type":"auth","token":"<token>"}' '{"type":"todayRead","reqId":"r1"}' \
  | websocat -n1 "ws://100.x.y.z:8420/ws"
# {"type":"authed","version":"2.2.4","features":["ack","today","settings"]}
# {"type":"today","reqId":"r1","ok":true,"data":{"board":{"state":"ok","mode":"claude",...}}}
```

Side effects: `inboxAct` changes the Inbox board (and Asana for `complete`);
snoozes are saved in `<userData>/today-snooze.json`; settings in config.json.

## Notifications, accounts, chat defaults and native push (2.3)

Advertised in `authed.features` as `alerts`, `accounts`, `chatDefaults` and `apns`; a phone shows each Settings group
only when its flag is there. Same rules as above: string `reqId`, fixed error codes, nothing queued. Every request here
first checks the socket's pairing is still paired (a revoked phone's queued messages are refused before anything runs),
and the writes check it again right before they change anything.

| Request | Fields | Reply |
| --- | --- | --- |
| `settingsRead` | | adds `newTabModel`, `newTabPermissionMode`, `phoneAlerts:{needs, done, handoff, team, quiet, names}` and `info.{webPush, apnsReady, apnsReason, thisPhoneApns}` (whether THIS phone, by its pairing, has an APNs token here) |
| `accountsRead` | | `{type:'accounts', ok, data:{claude:[{id, label, email, isDefault, login, active, usage:{known, headroom, limited, ageMs, windows:[{name, used, resetsAt, ageMs}]}, stale, sessionsRunning}], codex:[{id, label, isDefault, email, plan, login, active}], scanFailed}}`. Arrays only: account ids are user-influenced and never object keys. `data.unsupported` on Windows |
| `accountActivate` | `id` (string, or `null` for the Mac's default login) | `{type:'accountResult', ok, error}`. The same function as the desktop's Accounts switch (`accounts:activateClaude`): NEW tabs use it, running tabs stay. Followed by `settingsChanged` |
| `apnsRegister` | `token` (64 to 200 lowercase hex), `pairingId` (the phone's own id for this Mac, up to 64 of `[\w.:-]`) | `{type:'apnsResult', ok, error}`. Bound to the socket's pairing token, never to anything in the message; one token per pairing |
| `apnsUnregister` | | `{type:'apnsResult', ok}`: removes this pairing's token |
| `notifyResolve` | `ref` (32 hex, from an APNs notification) | `{type:'notifyTarget', ok, id}`: the tab the notification was about, or `null` (unknown, or older than 24 hours) |

New `settingsWrite` keys:

- `phoneAlerts`: a partial `{needs, done, handoff, team, quiet, names: boolean}`; any other key or a non-boolean is
  `bad-value`. `quiet` (off by default) holds notifications between Today's `quietAfter` and `morningAt`; `names` off
  sends only the event kind.
- `newTabModel`: `''` (Claude's default, no flag), `opus`, `sonnet`, `fable`, `haiku`.
- `newTabPermissionMode`: `''`, `acceptEdits`, `plan`, `auto`. `bypassPermissions` and `dontAsk` are not offered.
  Both apply only when a new tab starts `claude` (shared/new-tab.js `loginShellSpawn`, allowlisted again there and
  passed as separate words, nothing typed into the PTY, nothing eval'd).

What a notification is (electron/phone-notifier.js): a tab needs you (a permission prompt, a turn that handed back a
`!` command, or a tab's program exiting with an error), a tab finished, a command was handed back (listed in Tasks >
Commands), a team message arrived. Debounced (1.5 s for a prompt, 2 s for a finish, up to 10 s for a handed-back command
to be listed), 30 s per tab between buzzes (the newest held, sent if still true), at most 20 in 10 minutes, whatever is
due within a second goes out together and three or more become one summary, never for a tab the person is looking at
on the Mac (focused window, that tab on screen, keyboard or mouse used in the last two minutes). Payload: a title and
body built from a tab, project or teammate name and a fixed phrase, and a hashed tag; Web Push adds
`url: ./?open=<tab id>` (end-to-end encrypted to the phone), APNs adds `mac` and an opaque `ref` instead
(docs/native-push.md).

## Commands, To-do and Asana (2.3)

Advertised in `authed.features` as `commands` (the Commands view) and `projectTasks` (the To-do and Asana views). The
phone's Tasks screen shows a view only when its flag is there (`mobile/tasks-views.js`); Today and Inbox need `today`.
Code: `electron/mobile-tasks.js` (handler), `electron/command-run.js` (Run's checks and start, shared with the Mac's
Tasks > Commands), wired in `electron/main.js` (`setTasksBridge`) with the same functions the Mac's Tasks dropdown
uses. Same rules as above: string `reqId` (at most 64), fixed error codes, nothing queued across a reconnect. Every
request first checks that the socket's pairing is still paired (a revoked phone is answered `unavailable` before
anything runs), and every write checks again right before it changes anything.

| Request | Fields | Reply |
| --- | --- | --- |
| `commandsList` | | `{type:'commands', ok, list:[{tabId, tabLabel, project, projectPath, cwd, at, commands:[{id, text, why, state, hole, cwd, reply, at, edited, exit, startedAt, endedAt, runTabId}]}]}`. `state` is `waiting`, `running`, `done`, `failed` or `closed`. `hole` is the Mac's placeholder check for a waiting command (null when none). Never sent: the text that actually ran (an edit may hold a key) or the exit file |
| `commandsDismiss` | `tabId`, `id` | `{type:'commandResult', op:'dismiss', id, ok}` |
| `commandsRun` | `tabId`, `id`, `edited` (optional string, at most 2000), `asIs` (optional, `true` = the flagged placeholder is real syntax) | `{type:'commandResult', op:'run', id, ok, termId, error}`. `termId` is a new phone terminal (`term-mobile-<n>`) this socket may attach to. `error`: `unavailable`, `bad-request`, `not-waiting`, `placeholder`, `bad-edit`, `bad-edit-syntax`, `syntax`, `shell`, `write-failed`, `spawn-failed`, `failed` |
| `tasksProjects` | | `{type:'tasksProjects', ok, list:[{path, name, pending, asana}]}`: the Mac's known projects (the allowlist `createTerminal` uses), busiest first. `pending` counts open to-dos not from Asana, `asana` open Asana tasks |
| `projectTasksRead` | `project` (a path from `tasksProjects`) | `{type:'projectTasks', ok, project, tasks:[{id, title, done, source, dueOn, lane, assignee, notes, url, stage, createdAt, print}]}`. `print` names the version shown. No event log, runs or session links. `unknown-project` for any other path |
| `projectTaskAct` | `project`, `id`, `kind` (`complete`/`reopen`/`delete`), `print` (the task's, as shown) | `{type:'projectTaskResult', op, id, ok, error}`. `error`: `not-found` (the id must match exactly), `changed` (edited since the phone looked), `unavailable`, `unknown-project`, `bad-request`, `failed`. `complete` is LOCAL ONLY, as on the Mac: it never calls Asana |
| `projectTaskAdd` | `project`, `title` (1 to 500 characters, no control characters) | `{type:'projectTaskResult', op:'add', ok, id, error}` |
| `asanaSync` | `project` | `{type:'asanaSyncResult', ok, added, error}`: the Mac's "Sync from Asana" (reads Asana, updates this project's list). `error`: `no-key`, `unauthorized`, `unknown-project`, `unavailable`, `failed`, never Asana's own words |

Pushed with no content: `{type:'commandsChanged'}` whenever a command is handed back, run, finished or dismissed, and
`{type:'tasksChanged'}` whenever a project's list changes from the Mac or a phone. An open screen asks again.

### Run from the phone

The phone's Run goes through the same steps as the Mac's, in one synchronous call in main
(`command-run.js phoneRun`): the pairing; the command must still be waiting (a second tap finds it running and is
refused); `checkCommandRun` (an edit must parse as exactly one `! ` command line, an unfilled placeholder refuses
unless `asIs`, `bash -n` must pass with no warnings, the login shell must be zsh or bash); the pairing again; then
`writeRunScript` (a 0600 command file and wrapper in `<userData>/run`, both deleted as they start) and a new phone
terminal that runs the wrapper as its startup program (`shared/new-tab.js loginShellSpawn`). Nothing is typed into a
PTY and nothing is eval'd. The command is marked Running only once the terminal spawned; otherwise its files go and it
stays waiting. The Mac's one-time token exists only because its decision and its spawn are two IPC calls from a window;
here both happen in the same call. A phone Run terminal whose shell has not reached the script after two minutes (a
login profile waiting for input) is closed, so the files never wait on disk with no window to close them.

What the terminal prints as the command is the card's text, marked `(edited)` for an edit; the edited text itself is
never shown, logged or listed.

Command text, what Claude wrote around it and the full reply go only to the phone that asked, as the reply to its own
`commandsList`. Notifications carry the tab id only (docs/native-push.md).

### Accepted residuals

- An Asana sync a phone started finishes even if that phone is unpaired while Asana answers. It is the same pull a
  click on the Mac makes and writes only this Mac's task list; nothing goes to Asana.
- Closing an Asana card from the Inbox board (`inboxAct complete`, the only Asana write on the phone) checks the card's
  revision and print against a read made right before the board call, but the board's own endpoint does not compare
  them atomically (noted in `electron/inbox-board.js`).
- Any paired phone can attach to any listed terminal, a Run terminal included, as before: all of a Mac's paired phones
  are its owner's. A Run terminal shows the command as handed back, which the session's own terminal already shows.
- A task checked off from a terminal (`dobius-task-done`, the voice bridge) sends phones no event; an open To-do or
  Asana screen reads again every minute and whenever it comes back into view.

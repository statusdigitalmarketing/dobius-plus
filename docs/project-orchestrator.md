# Project orchestrator and work board

Sam, 2026-11-10: "we should probably also be able to pin a project orchestrator not just a global team orchestrator ... that way everyone stays updated and there's no duplicate work or cross-work going on."

One tab per project folder can be pinned as its **project orchestrator** (tab menu > Use as project orchestrator, badge `LEAD`). Every tab of that project then shares a small **work board**: what each tab has claimed, and what was finished or dropped in the last day with its result. The team orchestrator (`TEAM`, docs/team-communicator.md) is separate: it receives teammates' messages and, since 2.2.23, phone voice commands.

Code: `electron/project-board.js` (board), `electron/project-cli.js` (the `dobius-project` script), `initProjectBoard` in `electron/main.js` (wiring), `setLeadTab` / `getLeadTab` in `electron/agent-spawner.js` (the pin, `config.projects[path].leadTabId`, the same slot the Voice Conductor routes to).

## In a tab: `dobius-project`

Installed per instance in `<userData>/bin`, which every Dobius tab has on PATH. It must run inside a Dobius tab (`DOBIUS_TAB_ID`) and from inside that tab's project folder.

| Command | What it does |
|---|---|
| `dobius-project` | The board: the orchestrator, open work (who, what, since when, "its tab is closed", "moved on to another Claude session"), what finished or was dropped in the last 24 h |
| `dobius-project claim "<task>"` | Records the task for this tab and prints the board, so the tab can see overlap |
| `dobius-project done <id> "<result>"` | Closes it with a one-line result the next tab reads (a result is required) |
| `dobius-project drop <id> "<why>"` | Closes it unfinished |
| `dobius-project tell "<message>"` | Pastes the message, JSON-quoted as data (`<` `>` escaped), into the orchestrator's Claude prompt, named as coming from this tab, with every `dobius-send` guard (refused when Claude there has a draft, a question open, or someone typing, or is not at its prompt) |
| `dobius-project brief [start]` | Used by the hooks: prints the board only when the project has an orchestrator and the board changed since this tab last saw it (`start` prints it regardless) |

`<id>` is the 6-character id in brackets, or the item's exact task text when exactly one open item has it.

Only the tab that claimed an item, or the orchestrator, can close it while that tab is open. When a tab is closed its open items are dropped with "not finished: its tab closed". Snoozing a tab is not closing it: its work is shown as "its tab is snoozed" for as long as the snooze lasts, and when the session comes back (snooze return, or a resume from History) the work moves to the tab now running that session on the next command. Work counts as live while its tab is open, its Claude session is snoozed, or that session runs in another tab of the project; the session lookup runs only while some open work's tab is gone (answers kept 5 s, the 128 most recently created tabs), and the per-prompt brief never waits for it. Work also follows its session away from a tab whose shell is still open but no longer runs it, and the tab running an item's session may `done` or `drop` it. An orphan is dropped only after a lookup under 10 s old, and work dropped by the day rule or by its tab closing is reopened in the tab running its session if that session turns up within an hour, kept that hour even past the finished list's cap (a `drop` by a tab is final). Work whose tab vanished without a close (a window that went away) is dropped on the first `dobius-project` command (any tab, the per-prompt brief included) a day after a command first found the tab gone. That clock is kept in memory only: a relaunch restarts it, so a restored tab never loses its work while its window reattaches, and a tab that is seen again stops it. Accepted: a tab that comes back and goes again with no command run in the project meanwhile keeps its first clock (a resumed Claude runs the brief at start, which is a command). A claim made where no Claude session could be found (a plain shell) cannot follow a snoozed tab back; it stays open, shown as its tab closed, and goes by the day rule. Running `status`, `claim`, `done` or `drop` does not mark the board seen, so the next brief may repeat what the tab just read (a nested `claude -p` in the same tab could otherwise use up the parent's update).

## Bridge: `POST /project`

Loopback voice bridge (`127.0.0.1:8421`), `Authorization: Bearer <voice-bridge-token>`, `Host: 127.0.0.1:8421`, JSON body up to 64 KB.

Request:

```json
{ "cmd": "claim", "arg": "", "text": "Submit the 11/10 Hallandale batch", "tabId": "term-/Users/x/proj-3", "pwd": "/Users/x/proj" }
```

| Field | Type | Notes |
|---|---|---|
| `cmd` | string | `status` (or empty), `brief`, `claim`, `done`, `drop`, `tell` |
| `arg` | string | `brief`: `start` or empty. `done`/`drop`: the item id or exact text |
| `text` | string | `claim`: the task (200 chars). `done`/`drop`: the result (300). `tell`: the message (4000). Made one line, control and bidi characters removed |
| `tabId` | string | Must be a live Dobius tab. The project is derived from it, never taken from the caller |
| `pwd` | string | Must be inside that project folder (symlinks resolved), else 409 |

Response: `{ "ok": true, "lines": ["claimed [a1b2c3] Submit the 11/10 Hallandale batch", "", "..."] }` or `{ "ok": false, "error": "..." }`.

Errors: 400 (no tab id, bad arguments, empty task/result, unknown command), 404 (the tab is not open), 409 (outside the project folder, board or tab full, item belongs to another open tab, ambiguous or unknown item, no orchestrator for `tell`, `tell` from the orchestrator itself, the orchestrator refused the paste).

Curl:

```bash
curl -sS -X POST http://127.0.0.1:8421/project -H 'Host: 127.0.0.1:8421' \
  -H "Authorization: Bearer $(cat ~/Library/Application\ Support/dobius-plus/voice-bridge-token)" \
  -H 'Content-Type: application/json' \
  --data '{"cmd":"status","tabId":"'"$DOBIUS_TAB_ID"'","pwd":"'"$PWD"'"}'
```

Side effects: writes `<userData>/project-board/<first 16 hex of sha256(projectPath)>.json` (0600, temp file then rename, one write at a time a project); `tell` pastes into the orchestrator tab and presses Enter.

Bounds: 50 open items a project from live tabs (a claim past that is refused, nobody else's work is dropped), 5 open a tab, at most 100 open in all (the oldest from closed tabs are dropped first), 50 finished kept, none older than 7 days.

A guard, not a security boundary: anything that can read the bridge token can claim to be any tab (the same as `dobius-team` and `dobius-send`).

## Hooks

The managed Claude hooks block (Settings > Tab status dots) adds `dobius-project brief start` to SessionStart and `dobius-project brief` to UserPromptSubmit, marked `# dobius-project-brief`. Both do nothing outside a Dobius tab and always exit 0. The script reads at most the first 1 KB of the hook's input (for `session_id`, 1 s cap) and gives the bridge 2 s; the hook itself is capped at 5 s. A brief costs one loopback request a prompt and prints only when something changed for that Claude session.

## IPC (renderer)

- `projectOrch:get(projectPath)` -> `{ ok, leadTabId }`: the pinned tab id as configured (null when none), so the badge is right as soon as a window restores its tabs
- `projectOrch:set(tabId, on)` -> pins or unpins a tab of the calling window; the project is the tab's own. Unpin only clears a pin that is still on that tab.
- `projectOrch:changed` `{ projectPath }`: broadcast to every window when the pin or a board changes.

## Phone voice into the team orchestrator

Brett, Asana 1220329713038498. When a tab is pinned as **team** orchestrator and alive, a phone voice command (`/voice/audio`, `/voice/intent`) is pasted into it as `[voice from the phone] <transcript>` with the `dobius-send` guards, Claude only. The phone gets "Sent to your orchestrator tab "<name>"." through the usual `/voice/reply` poll, so older phone builds show it too. If the paste is refused the phone is told why and the command is not handed to the Voice Conductor as well (one agent per command). When the paste went in but Claude did not confirm taking it, the phone says so and to check that tab. With no team orchestrator pinned, or its tab gone, the Voice Conductor gets the command as before.

Since 2.2.24 every phone voice path types the way `dobius-send` does: the team orchestrator, the Voice Conductor, and `/voice/intent` with a `tabId` (direct mode). The transcript is made one line with escape sequences and control characters removed, and the paste is refused (the phone is told why) when that tab shows a permission prompt or a question, holds a draft, or someone is typing. A spoken "1" can no longer answer a dialog. Direct mode answers 409 with the reason instead of `ok`. `/handoff` (`dobius-handoff`) goes the same way and answers 409 unless the paste was submitted, and nothing is typed into the source tab.

The same guarded paste (Claude only) now carries scheduled tasks and iMessage commands into the Voice Conductor, Auto Mode's Asana dispatches, and a spawned agent's first prompt. A refusal that typed nothing is tried again later: a scheduled task keeps its slot, an Auto Mode task stays unseen for the next tick, and a spawned agent's prompt is retried for 20 s while Claude starts. A message that was typed but never confirmed is never sent twice.

Known limits (accepted): a claim stays on its tab while that tab's shell stays open after its session moved elsewhere (the tab running the session may still `done` or `drop` it); a session that comes back more than an hour after its work was dropped does not get it back; on Windows the phone and Conductor routes type one line and Enter as before 2.2.24, because the prompt checks need Mac process tools.

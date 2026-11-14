# Phone mode: drive a tab's Claude from the phone with real questions and permissions

Status: design, for review before any code. Branch `feat/phone-mode`.

## Why

Today the phone drives a tab by reading Claude's screen and typing keys into it. That is why:

- "Type something" on a question card does not work well: tapping it moves Claude's own cursor, and the next Send
  from the input bar is read by Claude as that option, not as the answer Sam typed (Sam, 2026-11-13).
- Two questions in a row make a tap fail with "the prompt changed": the card was read from one screen and the tap
  lands on another.
- Every Claude Code update can move the screen and break the parser.

Anthropic's Remote Control needs a claude.ai login on the phone, per account. Sam does not want that. Happy
(slopus/happy, MIT) solves the same problem by running Claude through the Agent SDK while the phone has the session:
questions and permission prompts then arrive as data through the SDK's `canUseTool` callback and are answered as data.
Nothing is read off a screen and nothing is typed.

Sam's decision (2026-11-14), to the question "Is that trade-off OK: the Mac tab shows an 'on your phone' view while
the phone has the session, and one keypress takes it back?": "sure yeah".

## What the person sees

On the phone, in a tab's chat:

1. The chat menu has **Move to phone**. A short sheet explains: "The Mac tab will show that this conversation is on
   your phone. Press Enter in that tab, or tap Give back to Mac, to move it back." Buttons: Move, Cancel.
2. If the tab cannot move now, the sheet says why in plain words (Claude is working, there is unsent text in the
   tab's box, the tab is not running Claude, the conversation has no messages yet, the setting is off).
3. Once moved, the header shows **On phone**. The composer sends messages, Stop stops the current turn.
4. A question from Claude is a card with each question, its options (one or several, as Claude asked), and a
   **Your own answer** text field per question. One Submit sends every answer. No cursor, no "Type something" step.
5. A permission prompt is a card naming the tool and what it will do (the command, the file and a short diff, the
   URL), with **Allow**, **Always allow** (only when Claude offers a rule for it, same as the Mac's "don't ask
   again"), and **Deny** with an optional note to Claude.
6. A plan (ExitPlanMode) is a card with the plan and **Approve** or **Keep planning** with a note.
7. **Give back to Mac** in the menu ends phone mode. When the Mac takes it back, the phone shows "Back on the Mac"
   and the chat returns to the normal Mac mode.

On the Mac, the tab shows a plain status screen while the phone has it:

```
This conversation is on your phone.
Press Enter here to bring it back to this Mac.

Claude is working: Running Bash (npm test)
```

followed by a running log of what Claude says and which tools it runs (each line capped), so a person at the Mac can
see progress. Enter brings it back. If Claude is mid-turn, the first Enter says "Claude is working on your phone's
request. Press Enter again within 5 seconds to stop it and bring the conversation here." Ctrl+C counts as Enter.
Typed or pasted text is ignored with one hint line: typing here does nothing until it is back on the Mac.

The tab's status dot follows phone mode: working, red while a question or permission waits for the phone, green when
the turn ends.

## Architecture

```
phone  --WS (paired token)-->  main (mobile-server)  --unix socket-->  runner (in the tab's PTY)  --SDK-->  claude
                                    phone-mode.js                     phone-runner.mjs                 (user's CLI)
```

### The runner runs inside the tab

When a tab moves to the phone, main stops the tab's Claude and restarts the tab's PTY with a new launch kind,
`phone`, through the existing restart path (`restarterFor`, `createTerminal`, `loginShellSpawn`). The tab's login
shell runs its startup files exactly as for a resume, then runs:

```
cd -- "$cwd" && ELECTRON_RUN_AS_NODE=1 "<Dobius binary>" "<phone-runner.mjs>"; claude --resume "$sessionId"
```

The second command is the take-back: whenever the runner exits, for any reason (Enter at the Mac, Give back on the
phone, an error starting the SDK, a crash), the tab resumes the conversation in the normal Claude TUI. The
conversation always ends up back on the Mac, never stranded.

Why the runner lives in the tab and not in main:

- **The environment is the tab's.** PATH from the user's rc files, direnv, `CLAUDE_CONFIG_DIR` from the tab's account
  pin, `DOBIUS_TAB_ID` and `<userData>/bin` on PATH. Claude's Bash tool sees what it would see in the TUI. Main's own
  environment (a Finder launch) has none of that.
- **Crash isolation.** A runner failure cannot block or crash main, and the stream of tool output never passes
  through main's event loop. Main only relays small state messages.
- **Clean shutdown.** Closing the tab or quitting Dobius closes the PTY, the runner and its claude child get SIGHUP
  (same foreground process group), and nothing is orphaned.
- **The Mac's view and Enter come for free** from the tty.

`ELECTRON_RUN_AS_NODE` with Dobius's own binary is already used in production (the gws MCP server for Claude Desktop),
so no separate Node is needed. The runner and the SDK load from the app bundle.

### The SDK

`@anthropic-ai/claude-agent-sdk` (pinned, 0.3.325 today; its version tracks the CLI's, 2.1.325 here). It is Anthropic's
supported way to drive Claude Code with structured input and callbacks.

- `pathToClaudeCodeExecutable` is the `claude` the tab's shell finds (`whence -p claude` / `type -P claude`, passed in
  by the launch script). So it is the same CLI, version and login as the TUI. The SDK's own per-platform native
  binaries (the optional dependencies) are excluded from the app bundle; we never run them.
- `resume: sessionId`, `cwd`, `settingSources: ['user', 'project', 'local']` and the `claude_code` system prompt
  preset, so CLAUDE.md, hooks, plugins, MCP servers and permission rules load as in the TUI.
- `permissionMode` and `model` are carried over from the stopped process's argv (`--permission-mode`,
  `--dangerously-skip-permissions`, `--model`), each checked against a fixed allowlist. A mode changed inside the TUI
  with Shift+Tab is not visible in argv; the phone session starts in the argv mode (accepted, see Limits).
- `CLAUDE_CODE_ENTRYPOINT=remote_mobile` unless the shell already set one. The SDK would otherwise tag the session
  `sdk-ts`, and both `claude --resume`'s picker and Dobius's History hide `sdk-*` sessions. This is Happy's fix
  (slopus/happy#1202).
- Streaming input (an async queue of user messages), so the query stays alive between turns and background-task
  messages keep flowing.

Alternative considered: speak the CLI's stream-json control protocol ourselves (`--input-format stream-json
--permission-prompt-tool stdio`) with no dependency. Rejected for v1: the protocol is the SDK's internal contract, not a
documented API, and the SDK is what Anthropic maintains against each CLI release.

### Questions and permissions

The runner's `canUseTool(toolName, input, { signal, suggestions, toolUseID })`:

- `AskUserQuestion` always goes to the phone, whatever the permission mode (Happy does the same; the SDK requires a
  person for it). The answer returns `{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: answer } } }`,
  where a multi-select answer joins its labels with ", " and a typed answer is the person's own text.
- `ExitPlanMode` always goes to the phone. Approve returns allow (and, if chosen, `setPermissionMode` to the mode the
  person picked); Keep planning returns deny with the person's note.
- Everything else reaches `canUseTool` only when Claude Code itself would have asked (its own permission rules and
  mode run first). It goes to the phone as a permission card. Allow returns allow with the original input; Always
  allow also returns `updatedPermissions: suggestions` (the same rule the TUI's "don't ask again" saves); Deny returns
  deny with the note, or Happy's default deny text.
- Each pending request has an id (`toolUseID`, scoped by `agentID` for subagents, as Happy does). An answer names the
  id; an answer for an id that is not pending is refused, so an answer can never land on a different question.
  The SDK's abort signal removes a pending request (the turn was stopped) and the phone is told.

### Main: `electron/phone-mode.js`

Owns a small registry: tabId -> { sessionId, token, socket, status, pending (at most 8), lastSendIds (at most 64) }.

- **Socket.** One unix socket, `<userData>/run/phone.sock`, in a 0700 folder (a short path under the temp dir when the
  userData path is too long for a socket). Newline-delimited JSON, each line capped at 256 KB, a connection that sends
  more is closed. A runner proves itself with its one-time 256-bit token (from its env, set at spawn, bound to the tab
  and session); the token is never logged and dies with the run.
- **Start (phone asks):** setting on, macOS, a desktop tab owned by a window, at most 4 phone runs at once, one start
  at a time (a lock). Then the same checks and order as the account move (`account-headroom-service.js moveOne`, which
  survived many review rounds): Claude is the sole program in the shell, its record names a session with a
  transcript, nothing is unsent in the box or held by the window, no input since the read, Claude is not working
  (record and hook agree it is idle or waiting on a person). Stop the pid (SIGHUP), wait for exit, claim the session
  for the tab (`claimSessionResume`), restart the tab with the `phone` launch. Wait up to 30 s for the runner's hello;
  without it, the run is dropped and the phone is told the conversation is back on the Mac (the launch script resumes
  it there anyway).
- **Waiting on a person at the switch.** If the tab was showing a question or permission when it moved, that prompt is
  lost when the TUI stops (Claude Code records the tool call as interrupted). The runner then sends one message on the
  person's behalf: "This conversation just moved to my phone while your last question or permission request was
  open, and it was cancelled. Please ask it again." So the card appears on the phone. This is the only message Dobius
  ever sends itself, and only in this case.
- **While on the phone**, the session counts as live: `liveClaudeSessionIds` and the claim gate include it, so no
  other surface resumes it (auto-resume, History, another tab, the phone's own Resume).
  - Every path that types into a tab already refuses here, because the foreground program is the runner, not Claude:
    dobius-send, /openTab, team delivery, voice routing, the selector card. The phone's own `submitPrompt` for a
    phone-mode tab is answered `opError: on_phone` (the phone uses `phoneSend` instead).
  - The account move and auto-move refuse a phone-mode tab by name. Snooze refuses it too. Tear-off and dock move the
    PTY as today; the runner keeps running.
- **End:** the runner reports `ended` with a reason, or its socket closes. Main drops the run, tells every phone
  watching the tab, and leaves the claim to the TUI resume that the launch script starts next (the tab-bound claim
  ends when that Claude appears, as today).

### Phone protocol additions (`docs/mobile-ws-protocol.md`)

Offered only when the Mac's setting is on: `authed.features` includes `phone`.

| Request | Answer | Effect |
|---|---|---|
| `phoneTake {id, reqId}` | `ack` or `opError {code, error}` | Starts the move |
| `phoneSend {id, text, sendId}` | `ack` or `opError` | Sends a message; the same `sendId` twice is sent once |
| `phoneAnswer {id, requestId, answer}` | `ack` or `opError` | Answers one pending card |
| `phoneStop {id}` | `ack` | Interrupts the current turn |
| `phoneGiveBack {id}` | `ack` | Ends phone mode; the tab resumes on the Mac |
| `phoneStateGet {id}` | `phoneState` | Current state |

Pushed to every socket that authorized the tab: `phoneState {id, on, status: starting|idle|working|waiting|ending,
pending: [...], error?}`. A pending item is `{requestId, kind: question|permission|plan, tool, questions?, summary?,
input? (capped at 4 KB), canAlways}`.

`answer` is one of `{kind: 'question', answers: {[question]: string}}`, `{kind: 'permission', allow, always?, note?}`,
`{kind: 'plan', approve, mode?, note?}`. Strings capped at 8 KB, at most 20 questions; anything else is refused.

Auth is unchanged: the same paired-device token and `_authedTabs` rules as `input`. The phone gains no new power:
it can already answer every prompt by pressing keys today.

The chat history still comes from the transcript (`loadTranscript`), which the SDK's Claude writes exactly as the TUI
does. Only sending and answering change.

## Setting

Settings > Phone > **Drive conversations from the phone (beta)**, off by default. macOS only in v1 (the launch is a
zsh/bash script; the same rule `restarterFor` applies today). When off, `authed.features` does not offer `phone` and
every `phone*` request answers `opError: off`.

## Safety and stability

- **Two writers on one transcript** is the failure that matters. The TUI Claude is confirmed exited before the runner
  starts, the session is claimed for the tab, and while the runner lives its claude child's own record holds the
  session. The runner exits only after its claude child has exited (it waits for the SDK's process to end, SIGTERM
  after 10 s, SIGKILL after 5 more), and only then does the launch script start the TUI resume.
- **Bounded:** at most 4 runs, 8 pending cards per run, 64 remembered send ids per tab, 256 KB per socket line, the
  Mac log lines capped at 2,000 characters each. The runner keeps no history: the transcript is the record.
- **Nothing is typed and nothing is eval'd.** Phone text becomes an SDK user message. The launch script passes the
  session id, folder and paths as positional parameters checked like the resume launch.
- **Secrets:** the run token lives only in the runner's env and main's memory; never logged, never sent to the phone.
- **Memory pressure:** a start is refused when the Mac is under critical memory pressure (one more Claude process).

## Limits we accept in v1

- Images from the phone are sent as file paths in the text, as today.
- Slash commands that need the TUI (/login, /model picker, /resume) do not work from the phone. Text commands that
  Claude Code accepts in a prompt (/compact) do.
- A permission mode changed with Shift+Tab inside the TUI is not carried over; the argv mode is.
- After Dobius quits or restarts, a phone-mode tab comes back on the Mac (the normal auto-resume).
- Windows: not offered.
- Phone-created terminals (`term-mobile-*`) are not offered (no window to restart them in).
- An `alias claude=...` in the user's rc is not used by the SDK (it runs the binary the shell finds on PATH).

## Code from Happy

Adapted (rewritten in JS, MIT notice kept at the top of `electron/phone-runner.mjs` and listed in
`THIRD-PARTY-NOTICES.md`): the `canUseTool` routing (AskUserQuestion and ExitPlanMode never auto-approved, the deny
text, subagent-scoped request ids), the streaming input queue that keeps the query alive between turns, and the
`remote_mobile` entrypoint fix. Happy's own server, encryption, app and local/remote switching loop are not used.

## Tests and ship-test

- Unit: the launch script (shape, positional parameters, refusals), the registry (one run per tab, caps, token
  check, send-id dedupe, answer for a non-pending id refused), answer validation, argv flag carry-over allowlist,
  `canUseTool` routing with a fake SDK.
- Ship-test in the isolated harness on a throwaway session (no fake transcripts in the real `~/.claude/projects`; a
  throwaway project folder whose transcript is deleted after): a real `claude` under the SDK, moved from a tab, a
  question answered with typed text, a permission allowed and denied, Enter at the Mac taking it back, the TUI
  resuming the same session, phone screenshots at 390 wide read back.

## Questions for review

1. Is the runner-in-the-tab split right, or should the SDK run in a utility process owned by main?
2. Is "always resume in the TUI after the runner exits" safe in every exit path (including a runner killed while its
   claude child is still alive)?
3. Is the auto "ask it again" message acceptable, or should the phone show the interrupted prompt and let the person
   decide?
4. Anything in the start sequence that differs from `moveOne` and should not.

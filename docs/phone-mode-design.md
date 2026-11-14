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
cd -- "$cwd" && ELECTRON_RUN_AS_NODE=1 "<Dobius binary>" "<phone-runner.mjs>" gate "$ticket" "$sessionId" \
  && claude --resume "$sessionId"
ELECTRON_RUN_AS_NODE=1 "<Dobius binary>" "<phone-runner.mjs>" done "$runId"
```

The second line runs after the first has completely finished, whatever its outcome: the gate refused, the fallback
failed to start, or the fallback Claude ran and exited. `done` reads a 0600 one-time token that main wrote for this
run at the gate's hello (`<run dir>/<runId>.done`, read and unlinked) and tells main the launch command is over.

Two processes, one supervising the other:

- The **gate** is the tab's foreground program. It draws the Mac's "on your phone" screen, reads the keyboard (Enter
  takes it back), and starts the runner as its child in a **new process group** of its own (`detached`, so the
  group id is the runner's pid), with a private pipe on fd 3 between them.
- The **runner** hosts the SDK. It spawns Claude itself through the SDK's `spawnClaudeCodeProcess` hook (plain
  `child_process.spawn`, never detached; checked in 0.3.325, where the SDK's own `query()` spawn is not detached
  either), so Claude is in the runner's group, and it reports Claude's pid and start time to the gate over fd 3 and
  to main over the socket **before** the SDK sends Claude anything.
- **Order** (Codex P2, design round 6: a runner orphaned before its hello had no cleanup owner):
  1. The gate connects first, with the ticket's token, and says hello with its own pid. Main records the run in
     `phone-runs.json` at once (before any runner exists) and answers with a second one-time token for the runner.
  2. The gate spawns the runner with a non-secret tag in its argv, `phone-runner.mjs run <runId>` (the run id is
     128 random bits and is not a credential), passes the runner token over fd 3, and reports the runner's pid and
     start time to main; main adds them to the record.
  3. The runner says hello with that token and spawns Claude only after main has accepted it. Main accepts it only
     for a run that is still `starting` in a tab that is still open, and only after one `ps` shows that pid is the
     one the gate reported and descends from the tab's PTY process. So a Claude can exist only for a run whose
     runner group main already knows.
  - Main never depends on a report arriving. For any run it has recorded, its cleanup (tab close, `ending`, quit,
    next launch) also finds the runner by its tag: one `ps`, processes running the Dobius binary with
    `phone-runner.mjs run <runId>`, which it SIGKILLs along with their group. A runner stopped and orphaned between
    spawn and its report is therefore still found.

The `&& claude --resume` is the take-back: whenever the runner exits, for any reason (Enter at the Mac, Give back on
the phone, an error starting the SDK, a crash, a SIGKILL), the tab resumes the conversation in the normal Claude TUI,
so it always ends up back on the Mac. But only after the gate has **confirmed the whole runner group is gone**
(Codex P1, design rounds 1 and 2: a SIGKILLed runner cannot wait for its child, a killed parent does not take its
child with it, and a missing session record proves nothing, since Claude writes it asynchronously and
`claude-presence.js` tolerates a missing or half-written one). The gate never looks for records. It sends SIGTERM to
the group (`kill(-pgid)`), then SIGKILL after 5 s, and polls `kill(-pgid, 0)` until it answers ESRCH, then checks the
reported Claude pid the same way (by pid and start time, in case anything left the group). Only a confirmed exit of
both lets the gate exit 0. Anything else (EPERM, still there after 15 s, a reported pid it cannot confirm) and the gate
prints why and exits non-zero: the tab is left at a shell prompt with the exact `claude --resume` line to run, and
nothing starts a second writer. Main also keeps its claim on the session until that point (see End below).

If the gate itself is killed (the tab closes, a SIGKILL), the runner sees fd 3 close, closes the SDK (which ends
Claude) and exits; main, which knows Claude's pid from the runner, confirms that exit before releasing anything.

Why the runner lives in the tab and not in main:

- **The environment is the tab's.** PATH from the user's rc files, direnv, `CLAUDE_CONFIG_DIR` from the tab's account
  pin, `DOBIUS_TAB_ID` and `<userData>/bin` on PATH. Claude's Bash tool sees what it would see in the TUI. Main's own
  environment (a Finder launch) has none of that.
- **Crash isolation.** A runner failure cannot block or crash main, and the stream of tool output never passes
  through main's event loop. Main only relays small state messages.
- **Clean shutdown.** Closing the tab or quitting Dobius closes the PTY: the gate gets SIGHUP and passes it to the
  runner group; a gate that dies without passing it closes fd 3, which ends the runner; and main confirms the Claude
  pid it was given is gone. The runner group is a background group, so it never reads the tty (the gate does) and
  never draws on it.
- **The Mac's view and Enter** stay in the tab, drawn and read by the gate.

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

Packaging: the SDK loads `@modelcontextprotocol/sdk` (which pulls zod, ajv, hono), about 60 MB installed. The runner is
bundled into one file at build time (esbuild, already present through Vite), so only the code the runner reaches ships,
and `node_modules/@anthropic-ai/claude-agent-sdk*` is excluded from the app's files.

Terms: the SDK's license points to Anthropic's legal agreements, whose Agent SDK guidance asks third-party products not
to offer claude.ai login. Dobius offers no login: the runner drives the person's own installed `claude` with whatever
login that CLI already has, exactly as the TUI tab does (and as Happy does). Flagged to Sam, not decided here.

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
- The card's sentence is the SDK's own `title` ("Claude wants to read foo.txt") with `description` under it, falling
  back to the tool name and input only when a CLI predates them. When the SDK sets `defaultToNo`, the card has no
  one-tap Allow (Allow sits behind a second confirm, as the TUI opens such a prompt on its decline option). When it
  sets `suppressAlwaysAllowRule`, there is no Always allow. MCP server names (`mcpServer.name`) are shown as untrusted
  text.
- Each pending request has an id (`toolUseID`, scoped by `agentID` for subagents, as Happy does). An answer names the
  id; an answer for an id that is not pending is refused, so an answer can never land on a different question.
  The SDK's abort signal removes a pending request (the turn was stopped) and the phone is told.

### Main: `electron/phone-mode.js`

Owns a small registry: tabId -> { sessionId, token, socket, status, pending (at most 8), lastSendIds (at most 64) }.

- **Socket.** One unix socket, `<userData>/run/phone.sock`, in a 0700 folder (a short path under the temp dir when the
  userData path is too long for a socket). Newline-delimited JSON, each line capped at 256 KB, a connection that sends
  more is closed. A runner proves itself with a one-time 256-bit token bound to the tab and session. The token never
  travels in env or argv (both readable with `ps eww`, and env is inherited by Claude, its Bash commands and MCP
  servers, where a diagnostic could print it into the transcript and the phone's chat: Codex P2, design round 1).
  Main writes it to a 0600 **ticket file** in the 0700 run folder; the launch passes only the ticket's path; the gate
  reads it, deletes it, and the runner connects with it. The SDK gets an explicit `env`: the runner's own environment minus every
  `DOBIUS_PHONE_*` name. A ticket not redeemed within 60 s is deleted by main. The token is never logged and dies with
  the run.
  - The gate opens the ticket (O_NOFOLLOW, must be a regular 0600 file owned by this uid), reads and unlinks it, and
    redeems it with its own hello (see Order); the runner gets a second one-time token from main through the gate
    over fd 3. So the file lives only between main writing it and the gate's first read. Each token is redeemable
    once; a second hello with either ends the run at once, and if the legitimate gate's or runner's hello is the one
    refused, the run fails loudly ("phone mode stopped: another program used its
    start ticket") and the tab resumes on the Mac. A hijack is therefore never silent.
  - Accepted residual (Codex P2, design round 2): a process running as the same macOS user that reads the ticket in
    that window can redeem it first. Node has no peer-credential check on a unix socket to bind the token to the
    gate's pid. Such a process already holds equal power today (the 0600 voice bridge token in the same userData lets
    it type into any tab, Claude's own prompts included, and it can read every transcript), so this adds no new
    capability; the loud failure above makes it visible.
- **Start (phone asks):** setting on, macOS, a desktop tab owned by a window, at most 4 phone runs at once, one start
  at a time (a lock). Then the same checks and order as the account move (`account-headroom-service.js moveOne`, which
  survived many review rounds): Claude is the sole program in the shell, its record names a session with a
  transcript, nothing is unsent in the box or held by the window, no input since the read, Claude is not working
  (record and hook agree it is idle or waiting on a person). The request names the session and the tab generation the
  phone was shown (`phoneTake {sessionId, gen}`); both are checked against the tab's record right before the stop, so
  a move the person asked for on conversation A can never stop or message conversation B that took the tab since
  (Codex P2, design round 2). Stop the pid (SIGHUP), wait for exit, claim the session for the tab
  (`claimSessionResume`), restart the tab with the `phone` launch.
  - That claim is a **phone claim**: held in main's registry for as long as the run exists, with no 10 minute expiry
    (the tab-bound reservation in `terminal-manager.js` expires after 600 000 ms and is not enough for a phone session
    of any length). `claimSessionResume` refuses every other caller while it is held.
  - **No hello in 30 s:** the run is NOT dropped (Codex P1, design round 4: dropping it released the claim while a
    suspended runner could still wake, be refused, exit, and let the gate start a fallback Claude on a session another
    tab had claimed meanwhile). The run moves to `ending` with its claim held, a later hello is refused, and the
    release rules under End apply. The gate keeps its own deadline too: the runner must tell it over fd 3 that main
    accepted its hello within 30 s, or the gate SIGKILLs the runner group (SIGKILL works on a stopped process),
    confirms it gone and only then starts the fallback, which main then sees running S in the tab and releases to.
- **Waiting on a person at the switch.** If the tab was showing a question or permission when it moved, that prompt is
  lost when the TUI stops (Claude Code records the tool call as interrupted). The runner then sends one message on the
  person's behalf: "This conversation just moved to my phone while your last question or permission request was
  open, and it was cancelled. Please ask it again." So the card appears on the phone. This is the only message Dobius
  ever sends itself, and only in this case.
- **While on the phone**, the session counts as live: `liveClaudeSessionIds` and the claim gate include it, so no
  other surface resumes it (auto-resume, History, another tab, the phone's own Resume).
  - Every path that types into a tab already refuses here, because the foreground program is the runner, not Claude:
    dobius-send, /openTab, team delivery, voice routing, the selector card. Not trusted alone: the choke points
    (`sendToTab`, `answerSelector`, `submitPromptDetailed`) also refuse a phone-mode tab by name.
  - The phone's raw `input` route (`mobile-tab-ops.js handleTabOp` to `writeRawInput`) writes to the PTY without
    looking at its foreground program, so a phone Enter delayed past the switch would reach the runner and take the
    conversation back (Codex P2, design round 1). Each tab has a **phone generation**, bumped when it moves to the
    phone and again when it comes back. The phone is told the generation with the tab list, the attach replay and
    every `phoneState`, and every phone-originated tab write (`input`, `submitPrompt`, `selectorKey`, `resize`)
    carries the generation **the phone was showing** when the person acted. A write is refused `opError: stale_view`
    when it is present and is not the tab's current one, checked when the frame arrives and again at the
    moment it is written (the existing `stillOk` check). So an Enter typed for prompt A, delayed past a whole trip to
    the phone and back, cannot answer prompt B (Codex P1, design round 2: a generation captured on arrival only
    protects writes already inside main). A write without a generation is accepted unless the tab is on the phone
    right now (`opError: on_phone`): the App Store app bundles its own pages and updates only through a new build
    (RELEASING-IOS.md), so refusing it would break every phone on an older build. A tab that never moved has the
    launch's base generation; asking for a tab's generation never creates one, and a full table (2000) drops a closed
    tab's entry before a live one's (Codex P1, implementation round 9). Generations never repeat across launches, even
    with the clock set back: `<userData>/phone-gen.json` holds a ceiling reserved before any generation past it is used,
    and a launch starts above it (implementation round 11).
    The desktop window's own keystrokes are not gated: they are how Enter takes it back.
  - The phone's own `submitPrompt` for a
    phone-mode tab is answered `opError: on_phone` (the phone uses `phoneSend` instead).
  - The account move and auto-move refuse a phone-mode tab by name. Snooze refuses it too. Tear-off and dock move the
    PTY as today; the runner keeps running.
- **End:** the runner reports `ended` with a reason, or its socket closes. The run moves to `ending`, the phones
  watching the tab are told, and **the phone claim stays held** (Codex P1, design round 2: dropping it at `ended`
  left a gap before the TUI's Claude appeared in which History could start a second writer). It is released only
  when one of these is true:
  - the tab's own Claude is seen running session S (`processSessionIds` for this tab), which then holds it as any
    running Claude does; or
  - main received `done` for the run (the launch command is over, so no fallback can still start: Codex P1, design
    round 7, a shell idle at its prompt is not proof, since a shell stopped between the gate and `claude --resume`
    looks idle and can run the fallback much later) AND every process main knows of for the run is confirmed gone:
    the runner group and the reported Claude pid when a hello was accepted, nothing more when none was (no hello
    means no Claude was ever started for the run, and a later hello is refused, so that runner can never start one:
    Codex P2, design round 5). If `done` itself cannot run, the claim stays held until the tab closes; that is the
    safe side; or
  - the tab closed AND its shell process is confirmed gone (main SIGKILLs it 5 s after the close if it is still
    there, so a stopped shell cannot carry a pending fallback past the release) AND main has confirmed the runner
    group and the reported Claude pid are gone; or
  - the tab closed before main accepted a hello, with its shell confirmed gone the same way.
  The shell is identified by pid and start time, and the start time is taken only from the ps listing at the gate's or
  runner's hello in which that live child descends from the shell's pid: a pid cannot be reused while a child is still
  parented to it (Codex P1, implementation rounds 8 and 9: a retry after the close, then a tab list lagging the shell's
  exit, gave the shell an unrelated process's identity). Without that identity only ESRCH proves the shell gone and it
  is never signalled; closing a phone tab SIGKILLs its PTY through the PTY object, so a stopped shell still ends. The run is marked dead first, so a hello arriving later is refused
    and that runner exits without starting Claude (Codex P2, design round 3: with no Claude pid, none of the other
    conditions could ever become true and the claim held the session until Dobius restarted).
  **Cleanup does not depend on the runner** (Codex P2, design round 3: a runner stopped with SIGSTOP handles neither
  SIGHUP nor fd 3 closing). From the accepted hello, main holds the runner's group id. When the run is `ending` and
  the group is still there 20 s later, or at once when the tab closes, main sends `kill(-pgid, SIGTERM)`, then
  SIGKILL 5 s later (SIGKILL works on a stopped process), and polls `kill(-pgid, 0)` until ESRCH; then the same for
  the Claude pid if it left the group (pid and start time must still match, so a reused pid is never signalled). A
  group id cannot be reused while any member of the group exists, so signalling it before ESRCH is safe; after the
  first ESRCH main forgets it and never signals it again. The polls run on a timer (every 250 ms, at most 30 s), never
  blocking main; a group still there after 30 s is logged and the claim stays held, with the tab's shell given the
  manual line. Until release, every other resume surface is refused with "this conversation is still coming back
  from the phone".

### Phone protocol additions (`docs/mobile-ws-protocol.md`)

Offered only when the Mac's setting is on: `authed.features` includes `phone`.

| Request | Answer | Effect |
|---|---|---|
| `phoneTake {id, reqId, sessionId, gen}` | `ack` or `opError {code, error}` | Starts the move; refused `stale_view` if the tab's session or generation changed |
| `phoneSend {id, runId, text, sendId}` | `ack` or `opError` | Sends a message; the same `sendId` twice is sent once |
| `phoneAnswer {id, runId, requestId, answer}` | `ack` or `opError` | Answers one pending card |
| `phoneStop {id, runId}` | `ack` | Interrupts the current turn |
| `phoneGiveBack {id, runId}` | `ack` | Ends phone mode; the tab resumes on the Mac |
| `phoneStateGet {id}` | `phoneState` | Current state |

Every request that changes something (`phoneSend`, `phoneAnswer`, `phoneStop`, `phoneGiveBack`) carries the `runId`
the phone was shown. A run id is 128 random bits, new for every move to the phone, and dies with the run. A request
whose `runId` is not the tab's current run is refused `opError: stale_run`, so a message written for one conversation
can never reach another that took over the same tab later (Codex P1, design round 1: a stalled `phoneSend` arrived
after the tab went back to the Mac and moved to the phone again on a different session). `phoneAnswer` is also bound
to its `requestId`, which must be pending in that run.

Pushed to every socket that authorized the tab: `phoneState {id, runId, sessionId, on, status:
starting|idle|working|waiting|ending, pending: [...], error?}`. A pending item is `{requestId, kind: question|permission|plan, tool, questions?, summary?,
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
  starts, and main holds a phone claim on the session from the stop until the TUI's Claude is seen running it again
  (or nothing holds it). The launch script starts the TUI resume only after the gate has confirmed the runner's whole
  process group, and the Claude pid the runner reported, are gone, whatever happened to the runner.
- **Bounded:** at most 4 runs, 8 pending cards per run, 64 remembered send ids per tab, 256 KB per socket line, the
  Mac log lines capped at 2,000 characters each. The runner keeps no history: the transcript is the record.
- **Nothing is typed and nothing is eval'd.** Phone text becomes an SDK user message. The launch script passes the
  session id, folder and paths as positional parameters checked like the resume launch.
- **Secrets:** the run token lives only in main's memory, the ticket file (until the gate's first read) and the
  gate and runner's memory; never in env or argv, never logged, never sent to the phone.
- **Memory pressure:** a start is refused when the Mac is under critical memory pressure (one more Claude process).
- **Quit, restart and update** (Codex P1, design round 4: the quit path exits after a 1.5 s drain and the updater
  path does not wait at all, so a five second SIGTERM-then-SIGKILL from main would never run, and a group frozen with
  SIGSTOP would outlive Dobius holding the session). At every quit, update install and restart, before the windows
  close, main sends SIGKILL straight to every phone run's group and reported Claude pid (no SIGTERM grace at quit:
  the transcript is already written turn by turn, and SIGKILL ends a stopped process) and confirms ESRCH, bounded at
  1 s and run inside the existing quit drain; the updater branch calls the same step in `performInstall` before
  `quitAndInstall`. Each accepted hello is also written to `<userData>/run/phone-runs.json` (group id, leader pid and
  start time, Claude pid and start time, session, tab, and the boot time from `sysctl kern.boottime`).
  - **Cleanup tracking is separate from the claim** (Codex P2, design round 5: a run released on the shell rule
    while its stopped runner group survived dropped out of both the quit sweep and the file). A record and its place
    in the quit sweep are removed only when main has confirmed ESRCH for the group and the Claude pid, never when the
    claim is released. Main starts that cleanup as soon as the run ends (SIGKILL 20 s after `ending` if the group is
    still there), independently of the claim.
  - At the next launch, before auto-resume and before any claim is answered, main reads that file. A record from an
    earlier boot is dropped without signalling anything: every process in it died with that boot, and its ids may now
    belong to anyone (Codex P2, design round 5). For a record from this boot, a recorded process still alive whose
    pid and start time match is SIGKILLed and confirmed gone, and until that is done every claim for its session is
    refused. A group whose recorded leader is gone but which still has members is signalled member by member. While
    a run lives, main refreshes the record's `aliveAt` (when it last confirmed the group was this run's) every 60 s
    and at `ending`. A member is this run's own, and is killed whatever its program (Claude's Bash tools and their
    children included: Codex P2, design round 6), when it started no later than `aliveAt`, since a group id is not
    reused while the original group has a member; a member tagged `phone-runner.mjs run <runId>` is killed whatever
    its start time. A command line that runs `claude` proves nothing (a recycled group id can hold someone else's
    Claude: Codex P1, implementation round 2); the run's own Claude is ended by its recorded pid and start time.
    After its members are ended, the group counts as gone only when `kill(-pgid, 0)` answers ESRCH (a member can
    fork while being killed). A member started after `aliveAt` with neither mark may belong to a reused id:
    it is left alone and logged, and the record is KEPT and checked again at the next launch, until the group is
    empty or the boot changes. A recorded leader pid alive with a different start time is a new process and is left
    alone. Only when nothing of the run's is left is the record deleted and the session free.
  - This startup path only matters after two failures at once: main dying without its quit step AND the gate dying
    without its own cleanup (a gate that outlives main gets SIGHUP when the PTY closes and kills its group). The one
    accepted gap: a tool process started in the last 60 s before such a double failure, with no tag, is left running
    and logged.

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
2. Is the gate enough to make the TUI resume safe in every exit path?
3. Is the auto "ask it again" message acceptable, or should the phone show the interrupted prompt and let the person
   decide?
4. Anything in the start sequence that differs from `moveOne` and should not.

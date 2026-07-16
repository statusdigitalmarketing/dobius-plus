# Voice Conductor — full port from v1 into v2 (`dobius/`)

**Branch:** `feat/voice-conductor` · **Substrate:** invisible/windowless (SDK agent-runner) · **Persona:** "Carson" (v1 said "Sam")

## What it is
A long-running background Opus Claude session that ingests voice transcripts, disambiguates them,
and dispatches work to other Dobius+ terminals / Asana / shell. In v1 it lived in
`electron/voice-conductor.js` + a web of support files. This ports the whole thing into v2.

## v1 source → v2 target map
| v1 file | Responsibility | v2 approach |
|---|---|---|
| `electron/voice-conductor.js` | lifecycle: spawn + auto-respawn background session | new `dobius/src/main/voice-conductor/` on the SDK agent-runner (`src/main/agents/agent-runner.ts`) |
| `electron/voice-bridge.js` | localhost HTTP + `dobius-send/tabs/reply/track/status/mark-done/spawn/ask/lead-tab` CLIs | reuse v2 `dobius-cli` dispatch-server (`src/main/dobius-cli/dispatch-server.ts`) + new CLI verbs; map tab ops to runtime `terminal.send`/`terminal.list` |
| `electron/mobile-server.js` `/voice/intent` `/voice/reply` `/voice/tabs` | transcript in, reply out | new RPC methods `voice.intent`/`voice.reply` over v2 WS transport (`src/main/runtime/rpc/`) |
| `electron/work-registry.js` | track dispatched work → auto-notify on completion | new `voice-conductor/work-registry.ts` |
| `electron/imessage-bridge.js` | iMessage send/recv for confirmations + reports | new `voice-conductor/imessage-bridge.ts` (AppleScript, macOS-gated) |
| `electron/asana-queue.js` + `auto-mode.js` | poll + process Asana queue | new `voice-conductor/asana-queue.ts` (Asana MCP available in-session) |
| `electron/scheduled-tasks.js`, `conversation-router.js` | timers + routing helpers | fold into conductor as needed |

## Phases (each: implement → typecheck/build → verify → commit)
- **Phase 0 — Setting + UI toggle.** `VoiceSettings.conductorEnabled` + default + a Voice Conductor section in the Voice pane + settings-search entry. *(This is the "add the setting in the UI" ask.)* ← START HERE
- **Phase 1 — Core session lifecycle.** Background Opus SDK run, Carson-fied system prompt, auto-respawn on exit, start/stop driven by the setting + app boot. Survives updates (pkill-daemon-safety).
- **Phase 2 — Dispatch bridge + CLIs.** Port the `dobius-*` verbs onto the dobius-cli dispatch-server; map tab ops to runtime terminal RPC; install CLIs to `~/.local/bin`.
- **Phase 3 — Work registry.**
- **Phase 4 — Voice input path.** `voice.intent`/`voice.reply` RPC feeding the conductor + returning its one-line reply.
- **Phase 5 — iMessage bridge** (macOS-gated).
- **Phase 6 — Asana queue + auto-mode.**
- **Phase 7 — scheduled-tasks / conversation-router glue.**

## Guardrails
- Do NOT sweep the unrelated in-flight `app-skin` changes into these commits — stage only conductor files.
- No hardcoded hex; use tokens (STYLEGUIDE). No `max-lines` disables; split modules.
- Cross-platform: iMessage/AppleScript pieces gated to macOS.
- Conductor process/daemon must survive `pkill -f "Dobius+"` (see NOTES pkill lesson).

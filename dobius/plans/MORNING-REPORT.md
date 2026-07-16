# Overnight build — morning report

Branch: `feat/asana-config` (off `feat/imessage-bridge`). Nothing pushed. App rebuilt and installed to `/Applications/Dobius+.app`.

## Shipped, built, installed, and running (Phases 0–2)

| Phase | What | Status |
|---|---|---|
| **0** | Asana config: `asana-config.json` (userData) + PAT in `safeStorage` `.enc`; **Automation** settings section (token, build/review lane GIDs, Auto Mode toggle) | ✅ built, committed `5428b0f`, installed |
| **1** | Asana queue + **Tasks** right-sidebar panel: build lane (mine) + review lane (Sam), Sync button, local done-tick, gated Complete-in-Asana | ✅ built, committed `0136ecb`, installed |
| **2** | `dobius-*` CLI spine: localhost:8421 token-secured server + `dobius-send`, `dobius-task-done`, `dobius-status` in `~/.local/bin` | ✅ built, committed `205f291`, installed |
| **4a** | **Prompts** snippet panel (right sidebar): add/edit/delete snippets, click to inject into the active terminal (unsent, so you edit first) | ✅ built, committed `1f28414`, installed |

**Try it:** open Dobius+ → Settings → Automation → paste an Asana Personal Access Token + confirm the two lane GIDs → open the **Tasks** tab in the right sidebar → Sync. From any terminal: `dobius-send "hello"` types into the active terminal; `dobius-task-done "<task title>"` ticks it in the panel.

### How I built it (execution model)
- Phase 0 was written by **codex** (you launched it), reviewed by me (token isolation, out-of-GlobalSettings, additive UI all verified).
- Phases 1–2 I implemented directly (codex can't run unsandboxed without you awake to launch it), each: typecheck + `build:electron-vite` green → self-review against the wiring plan → commit (pre-commit hooks passed) → install.
- Every phase held the safety invariants: **the single Asana write is user-click-only** (poller and local-done never call it), **the PAT never crosses to the renderer** (only a `hasToken` boolean), and **all UI is additive** (no existing component restyled).

## Not built tonight — specced and ready (Phases 3–5)

I stopped implementing here rather than rush the deepest-integration phases into broken code overnight (as promised). All wire-level facts are captured in `plans/WIRING-PLAN.md` + the research below, so these are fast to finish in a **supervised** session (they spawn a headless `claude` and/or auto-send messages, which shouldn't run unattended).

- **Phase 3 — Voice Conductor + Auto Mode + status-bar indicator.** Reuse dobius's hidden-PTY spawner (`src/main/rate-limits/claude-pty.ts`) for the headless `claude --system-prompt-file … --model claude-opus-4-8` session; auto-mode polls Asana → injects `[auto-<gid>]` (cap 3/tick, `seen[]` FIFO 500, control-char strip). **Must ship OFF by default.**
- **Phase 4 — Costs / Build Monitor panels** (Prompts done, see 4a above). Data contracts captured: Costs pricing (opus 15/75, sonnet 3/15, haiku 0.80/4 per 1M; default→sonnet) reading `~/.claude/projects/*.jsonl` usage; Build Monitor reads `claude-progress.json` + `HANDOFF.md` (health = `100 − failures*10 − restarts*5`).
- **Phase 5 — agent-spawner / askSam / scheduled-tasks / work-registry.** Reuse dobius `claude-agent-teams-service.ts` for spawning (retires the shell-injection guard — pass `--model` as argv). Keep `conversation-router` (pending-map, oldest-resolves-first, 5-min timeout) as-is.

### Deferred (as planned): mobile-server (A9), Board/Pipeline/Orchestrator (B7 — overlaps dobius's native agent UI), 18 custom themes.

## Notes / follow-ups
- Old `dobius-*` scripts from the standalone app still sit in `~/.local/bin` (dated earlier); only `dobius-send`, `dobius-task-done`, `dobius-status` were rewritten to target the fork. The rest light up as Phases 3–5 land.
- Both apps use port 8421; the server logs and no-ops on conflict, so don't run the old dobius-plus and the fork at the same time.
- The iMessage bridge (from before tonight) remains committed on `feat/imessage-bridge`, which this branch is stacked on.

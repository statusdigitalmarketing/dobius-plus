# TASK 8.1 — Automation Destinations (notify with results, depth modes)

## What
Automations can deliver run results to configurable **destinations**. A destination is a named, typed notification target managed in the UI and picked per automation.

- Destination types (v1): `telegram`, `imessage`, `system` (OS notification), `asana` (comment on a task), `email` (SMTP).
- Per-automation notification settings: `destinationId`, `notifyOn` (`always` | `failure`), `depth` (`ping` | `brief` | `full`).
- Depth modes shape the delivered text:
  - `ping` — one status line: name, status, duration.
  - `brief` — status line + agent's final summary (~300 chars).
  - `full` — status line + final output up to the channel's limit (Telegram 4096, iMessage 1400, email/asana generous).
- Automation prompt templates get a NOTIFY convention: prompts instruct the agent to end with a `NOTIFY:` line; delivery prefers that block over raw output tail.
- "Send test" button on each destination.

## Why
Runs currently land only in run history. User wants results pushed to Telegram/iMessage/etc. with controllable verbosity ("simple text", depth modes, strong stock scripts).

## Where (planned files)
- `src/shared/destinations.ts` — types.
- `src/main/destinations/destinations-store.ts` — CRUD + atomic persistence (copy agents-config-store pattern).
- `src/main/destinations/destination-delivery.ts` — `deliver(dest, message)` + per-type adapters (imessage reuses imessage-send; telegram raw https; system Electron Notification; asana reuse auto-mode client/fetch; email nodemailer).
- IPC: `destinations:list/save/delete/test` handlers + preload exposure (mirror automations:* pattern).
- Automations service: persist new fields; hook terminal run status → render message by depth → deliver.
- Renderer: destination picker + depth/notifyOn fields in AutomationEditorDialog; destinations manager UI (settings pane or automations page section — decide from explorer report); test-send button.

## Test / verify
- `pnpm tc` (typecheck node+web) exits 0; `pnpm lint` passes (incl. localization catalog).
- Unit tests: destination normalization, depth rendering (message shaping incl. NOTIFY block extraction, truncation per channel).
- Manual: create telegram destination with real chat id, test-send, run an automation with runNow, confirm delivery.

## Risks
- Localization catalog gate on new UI strings (regen script required).
- Secrets (bot token, SMTP password) must live only in userData config, never in repo. UI must not echo them back in logs.
- Cross-platform + SSH rules: imessage adapter is darwin-only — guard and surface a clear error on other platforms; nothing may assume local-only.
- Editor dialog is large; slot fields in via the existing per-field component pattern.

## Estimate
~600-900 line diff across ~14 files.

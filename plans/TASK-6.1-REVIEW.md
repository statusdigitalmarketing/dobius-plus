# TASK-6.1-REVIEW — Per-Account CLI Path

## Changes reviewed

**electron/config-manager.js**
- `saveAccount` now persists `cliPath` (claude accounts only, max 500 chars). Sanitization pattern matches existing `claudeJsonPath` handling. No issues.

**electron/terminal-manager.js**
- `createTerminal` already accepted `accountEnv` in the working tree; updated to strip `DOBIUS_CLI_DIR` before passing env to PTY (prevents leaking the internal key into the user's shell environment). Prepends the CLI dir at the front of PATH when set.
- One thing fixed on review: original code had `...accountEnv` without stripping `DOBIUS_CLI_DIR` — corrected via destructuring.

**electron/main.js**
- `resolveActiveCliPath()` defined once above `createWindow()` — used by both `orchestration:decompose` and `prompt:improve`. Falls back to `CLAUDE_PATH` env var, then bare `'claude'` if no active account has a cliPath set. Safe fallback — no regression for existing setups.
- `terminal:create` handler now passes `DOBIUS_CLI_DIR = path.dirname(account.cliPath)` when a Claude account with a `cliPath` is assigned to the project.

**src/components/Dashboard/AccountsSection.jsx**
- `form` state includes `cliPath` field (default `''`).
- `cliPath` included in save payload only when non-empty (no phantom empty strings stored).
- Edit flow pre-populates `cliPath` from existing account.
- "Add Account" reset clears `cliPath`.
- Card shows truncated path when set (left-truncated at 40 chars, shows `…last37`).
- CLI path input shown for Claude accounts only (not Codex).

## One fix applied
Removed `DOBIUS_CLI_DIR` from the terminal's env via destructuring — it's an internal routing signal, not a var that should pollute the user's shell environment.

## Risk assessment
Low. All changes are purely additive — accounts without `cliPath` continue to work as before. The PATH prepend only fires when `DOBIUS_CLI_DIR` is set. `resolveActiveCliPath` has a safe fallback chain.

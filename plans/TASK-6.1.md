# TASK-6.1 — Per-Account CLI Path

## What
Add an optional `cliPath` field to each saved Claude account. When set, the CLI at that path is prepended to the terminal's PATH (so `claude` in the shell resolves to the account's binary), and used directly for orchestration/prompt-improve calls in main.js.

## Why
Users may have multiple Claude Code CLI installations (e.g. stable vs. beta, different npm global prefixes, nvm-managed versions). Currently the app always uses `process.env.CLAUDE_PATH || 'claude'` globally. Binding a CLI path to an account lets different accounts use different binaries without environment gymnastics.

## Files Changed
1. `electron/config-manager.js` — add `cliPath` to `saveAccount` schema
2. `electron/terminal-manager.js` — accept `cliPath` in accountEnv; prepend its dir to PATH
3. `electron/main.js` — pass `cliPath` in accountEnv; resolve CLI path for orchestration/prompt-improve from active account
4. `src/components/Dashboard/AccountsSection.jsx` — add `cliPath` input field to form; display on card

## Test
- Add a Claude account with a CLI path set → terminal session prepends that dir to PATH
- `which claude` in a new terminal for that project returns the correct binary
- Orchestration decompose uses the active account's CLI path
- Accounts without a cliPath continue working exactly as before

## Risks
- If the entered path doesn't exist, the terminal falls back to PATH resolution naturally (no crash — directory just doesn't get prepended)
- No impact on non-Claude (Codex) accounts — cliPath is Claude-only

## Estimate
~45 min

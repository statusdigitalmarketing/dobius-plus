# Multiple Claude and Codex accounts on Windows (design)

Sam, 2026-11-15: sign in to several Claude and Codex accounts in Dobius+ on Windows and switch between them, like
on the Mac. Today Windows hides Settings > Accounts and applies no saved account (spawn-account-env.js, main.js
`activeClaudeAccountEnv`, `resolveActiveCliPath`, the phone's `activateAccount`), because profiles are shared by
symlink and a symlink needs admin or Developer Mode there.

## What the Mac does (unchanged)

- An account is a config dir: Claude `~/.claude-profiles/<id>` (CLAUDE_CONFIG_DIR), Codex `~/.codex-profiles/<id>`
  (CODEX_HOME), or a Codex API key.
- The active account (or a project's own account) is applied to every NEW terminal at spawn. Open tabs keep theirs.
- Each profile links the shared setup back to the default dir (`SHARED_ENTRIES`: projects, history.jsonl,
  settings.json, CLAUDE.md, skills, commands, agents, plans, stats-cache.json; Codex: `SHARED_CODEX_ENTRIES`), so
  only the login differs between accounts. Re-checked at every spawn (`shareProfile`).
- Sign in: Settings shows `claude auth logout` / `claude auth login --email <addr>` to run in a tab that runs as
  that account.

## Windows plan (first release)

1. **Linking without admin.** A directory entry is linked as a **junction** (`fs.symlinkSync(target, link,
   'junction')`), which needs no privilege. A file entry tries a file **symlink** first (works with Developer Mode or
   admin); on EPERM/EACCES it falls back to a **hardlink** (`fs.linkSync`), which needs no privilege on the same
   volume (both live under %USERPROFILE%). Claude and Codex write these files in place (on the Mac every profile's
   file links have survived months of use; the only `.pre-share-*` copies are from first linking), so a hardlink
   stays one file. A hardlink is recognised as shared when `fs.statSync(link, {bigint:true})` and the target agree on
   `dev` and `ino`. If the two ever diverge (something replaced one by rename), the existing real-file branch sets
   the profile's copy aside (`.pre-share-*`, nothing deleted) and links again, as it does on the Mac today.
2. **Credentials.** Claude on Windows keeps the login in `<configDir>/.credentials.json` (no Keychain), which
   `hasClaudeCredentialFile` already reads. `loginState` on Windows answers from that file alone: present and
   parseable `in`, absent `out`; the Keychain probe is never run there. Codex already reads `<home>/auth.json`.
3. **Applying accounts.** Drop the Windows exclusions in spawn-account-env.js (`accountEnv`, both share calls),
   `activeClaudeAccountEnv`, `resolveActiveCliPath` and the phone's `activateAccount`. CLAUDE_CONFIG_DIR, CODEX_HOME
   and CLAUDE_CODE_PLUGIN_CACHE_DIR go through the same env allowlist PowerShell launcher as every other variable.
4. **Settings.** Show Accounts on Windows. Inside it, the parts built on Mac-only machinery stay hidden there:
   Switch running sessions (ps + Keychain re-login), Account usage (statusLine hook, off on Windows), and the tab
   menu's "Move to account..." (process moves). Sign-in commands are PowerShell-quoted on Windows.
5. **Paths.** Every account path check uses `shared/platform.js` (`isAbsPath`, `isInsidePath`), never a leading
   slash; `~` expansion uses `os.homedir()`.

Not in this release on Windows: moving running sessions to another account, usage meters and auto-move. They depend
on process scans and status hooks Windows does not have yet.

## Test plan

- Unit: the Windows link strategy behind an injectable fs (junction for dirs, symlink then hardlink fallback for
  files, hardlink recognised as shared, divergence set aside), and `loginState` on win32 never calling `security`.
- Windows CI smoke (`scripts/windows-smoke.mjs`): create a profile through Settings, confirm the junctions and file
  links on disk, make it active, open a tab and read `$env:CLAUDE_CONFIG_DIR` back, switch back to Default.
- Max on his PC: sign in to two real accounts and switch.

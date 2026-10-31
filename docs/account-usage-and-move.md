# Account usage and Move to account

Two things, both manual and both local.

**Usage panel** (Settings > Accounts > Account usage). For each Claude account: 5-hour and weekly use, pace, a forecast of when it runs dry, and how old the figure is. Figures come from the statusLine reporter (`electron/claude-usage.js`), one record per session under `<userData>/usage`, folded into `<userData>/usage-history.json` by `electron/account-headroom-service.js`. Each window stands on its own, and a window with no live figure reads Unknown, never 0%: real records often carry only `seven_day`, so a row can read 5 hour Unknown, Weekly 99%. A real figure nobody is refreshing is marked stale. A resumed session reports nothing until its first API call on the new account, so a move carries no figures across (checked on real accounts). Records past 8 days are deleted hourly.

**Move to account** (tab context menu). Restarts one tab, or every tab in the window, on another logged-in account and resumes its conversation. The tab is pinned to that account across relaunch, tear-off and reopen. The global active account does not change.

## What a move does

Only one move runs at a time, across all windows. A second one is refused.

**1. Check before touching anything.** Any failure refuses the move with a plain reason and leaves the tab running:

- Exactly one Claude, as a child of the tab's shell. `exec claude`, no Claude, or another program beside it are refused. A Claude that never got a message has no transcript, so there is nothing to resume: it moves as a plain `claude` on the target, verified by account alone.
- Its conversation named by Claude's own `<configDir>/sessions/<pid>.json`, and its working folder readable and present. No auth token and no other HOME or USER in its environment (its login could not be named), and the shell is zsh or bash, which are what can start the resume.
- The target logged in (read last, right before Claude is stopped), and both sides linked to the shared conversation store, not the tab's own credential and not the same login. A login that cannot be named is refused, on either side: another spelling of a folder (`/p/b/.`, `/p/b/`, a symlink), a credential or metadata file linked out of its folder, a hard-linked credential file, or two default metadata files that disagree.
- No input since the tab was judged. Move all also skips tabs mid-turn, on a question, or with unsent text, and names them. A single-tab move names a stopped turn or lost text in its confirm, read at the click, and main refuses a draft that appeared after that.
- A tab on Claude's limit menu is neither mid-turn nor a draft, since that is the main reason to move. It takes all of: the menu's own rows as the last rows on screen (top edge, question, numbered options led by `1. Stop and wait for limit to reset`, one pointer, the `Enter to confirm` footer), Claude's record saying `waiting`, and a hook status other than `needs`. On real 2.1.316 the record says `waiting` and the hook goes `working` then `idle`, never `needs` over 150s. Any other drawing falls back to busy, the safe way.

**2. Stop and restart.** SIGHUP to Claude, a bounded wait for it to exit, a claim on the conversation, then a new login shell on the target with the resume started by the launch path (`loginShellSpawn` in `shared/new-tab.js`). Nothing is typed, so keys pressed meanwhile cannot mix into a command, and a slow shell rc only uses up the wait. The claim is released on every abort after it.

**3. Verify.** Success is reported only when the new process's own environment (`claude-process-scan.js`) names the target's credential, carries no auth token, its own `sessions/<pid>.json` names the conversation, and the target folder still names the same login. Otherwise the dialog says what is really running, and the pin follows that rather than the request. Two endings do not wait out the 45 seconds: the target asking whether to trust this folder (answer it in the tab, the conversation carries on), and Claude exiting right after it started.

IPC, all owner-checked per tab: `accounts:usage`, `accounts:moveTargets`, `accounts:moveCandidates`, `accounts:move`.

## Known limits

Accepted, not fixed. Each is a wrong or missing figure, or a refusal that does not fire, in the situation described.

1. **First sight of a folder.** With no history yet for a folder, a session still running on it can repaint an earlier login's cached figure after the boundary, and that figure shows as the current login's until a new one arrives.
2. **Out-of-order record.** A record that only becomes readable later, holding a higher figure with an older time, shows with the age of the newer lower report.
3. **Token inherited at launch.** With `CLAUDE_CODE_OAUTH_TOKEN` in Dobius's own environment, moves are refused, but usage from a session in folder B is still recorded against B's email although it is the token's login.
4. **Home-level metadata symlink.** `~/.claude.json` linked to another profile's file names the wrong login for Default, so a same-login move can be allowed. A metadata or credential file linked inside a profile folder is caught; this home-level one is not.
5. **Unlisted alias login.** Logging in through a spelling not listed in Accounts (`CLAUDE_CONFIG_DIR=/p/b/. claude`) rewrites the folder's metadata while the listed spelling's Keychain item stays on the old login, so a same-login move can be allowed. Step 3 cannot see this either, because the credential key matches.
6. **Two profiles on one login.** Re-logging one of them clears that login's higher figure, so the other row can show a lower one until its next report.
7. **Report right after a login.** A valid report that arrives just before the next sample is taken for the old login's and ignored until its figure changes. The row stays Unknown meanwhile, which is the safe direction.
8. **Placeholder drawn without dim.** Claude's placeholder and ghost suggestion are recognised by the dim attribute, confirmed on a 2.1.314 frame. A version that draws them otherwise reads as unsent text, so Move all skips that tab and names it.
9. **Token no process shows.** A token set inside Claude's own settings files (an `env` block, `apiKeyHelper`) is applied inside Claude and never appears in its process environment, so step 3 cannot see it and reports success. A token exported by the shell is seen and reported, by name only.

## Open, for Sam to judge

Found by Codex on the final pass, not fixed, not accepted.

- **A resume queued for more than 10 minutes (rated High by all three lenses).** The hold on a conversation expires after 10 minutes. If the target's shell startup is blocked that long, and the same conversation is resumed in another tab meanwhile, the queued resume also starts when the shell finishes, and two Claudes write one transcript. Needs a shell blocked over 10 minutes and a manual resume of that conversation.
- **Cleanup racing a swapped folder.** Replacing the usage folder with a symlink between the check and the listing could delete a file named like a session record in the other folder. Needs local write access, and a file with a session-id name.
- **A shell wrapper that changes the resume** keeps the hold after the mismatch, so that conversation can't be moved for up to 10 minutes.
- **A phone replacing a draft during the confirm** can lose the new text.
- **`USER='sam TAG=x'`** passes the environment check as `sam`. Needs a crafted Keychain item.


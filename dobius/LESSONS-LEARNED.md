## 2026-07-07 — Pre-commit gate + blind patches cost three commit attempts
- Tried: committing P2 with `git commit` and letting husky/lint-staged find errors; patching files via python heredoc `assert old in h` blocks written from memory of the content.
- Failed because: (1) a failing lint-staged pre-commit REVERTS the working tree to a backup stash — one revert appeared to eat 22 files of uncommitted work until recovered via `git stash pop`; (2) heredoc exact-match patches missed because the real file content differed from what I assumed (oxfmt rewrites, different import shape) — assertion failures burned attempts; (3) `pgrep -f 'MacOS/Electron'` went blind when the bundle's executable was renamed `Dobius+`, causing false NOT_RUNNING alarms.
- Works instead: run `pnpm exec oxlint <changed files>` BEFORE `git commit`; Read exact lines then use the Edit tool for surgical changes (heredoc-python only for bulk mechanical rewrites, always after grep-verifying the anchor); after any husky failure, work is in the lint-staged backup stash (`git stash list` / `git fsck` for dangling commits); process checks match the .app path, not a hardcoded executable name; with a concurrent author in the repo, commit named files only — never `git add -A`.

## 2026-07-09 — Background `git commit` failed silently 3x (pre-commit max-lines)
- Tried: committing via background Bash with `git commit -q ... && echo COMMITTED`, then grepping the output for status lines only.
- Failed because: the pre-commit hook (lint-staged oxlint) rejected max-lines violations; lint-staged restored the working tree, the commit never landed, and the missing "COMMITTED" echo went unnoticed in the grep. Installs kept "working" because builds use the working tree, masking the loss.
- Works instead: after every commit, verify with `git log --oneline -1` (assert the new hash/subject), never trust an echo; and when a file nears 300 counted lines, split it BEFORE committing (house rule forbids max-lines disables).

## 2026-07-12 — `npx tsgo --noEmit` fails on the repo root tsconfig
- Tried: typechecking new renderer code with the obvious `npx tsgo --noEmit` from `dobius/`.
- Failed because: `dobius/tsconfig.json` sets `"baseUrl": "."` (+ `paths`), and tsgo hard-errors on it — `TS5102: Option 'baseUrl' has been removed` and `TS5090: Non-relative paths are not allowed`. The root tsconfig is a path-alias/editor config, not a buildable project, so bare tsgo never runs.
- Works instead: use the real `typecheck` script's three project files — `npx tsgo --noEmit -p config/tsconfig.tc.web.json` (renderer), `-p config/tsconfig.node.json` (main/electron), `-p config/tsconfig.tc.cli.json` (cli). Renderer/UI edits go through the `.tc.web.json` project. `npm run typecheck` runs all three.

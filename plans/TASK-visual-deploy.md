# TASK — Deploy buttons in the Visual window (Preview, then Go Live)

## What
Add two git-based deploy actions to the Visual phone preview so a website can go
from local edits to the live site without leaving Dobius+:
- **Deploy to Preview** — commit working changes locally, push them to a throwaway
  `visual-preview` branch. The host (Vercel) builds a preview at a stable URL.
  Production is untouched.
- **Go Live** — push `main` to GitHub. The host auto-deploys to the real domains.
Each action is behind a confirm dialog that shows exactly what will ship.

## Why
Carson's loop: edit the site -> see it on Local -> check a real hosted Preview ->
press Go Live to update the public website. Deploy = push to GitHub on purpose;
that is the point of the button. He chose Preview-then-Promote with a confirm
dialog before anything goes live.

## Environment facts (verified)
- pocket-cologne is a git repo on `main` tracking `origin/main`; tree clean.
- Push auth works (osxkeychain helper; `git ls-remote` succeeds).
- Vercel deploys via GIT integration: push main = live, push any other branch =
  preview URL. Vercel CLI is NOT installed -> use git only, no new tooling.
- Site files may live in a subfolder (website/), but git ops run at the repo
  TOPLEVEL (`git rev-parse --show-toplevel`), so all changes are captured.

## Design (git-based, no Vercel CLI/API)
New `electron/deploy-service.js`, all git via `execFile` (no shell, no null
bytes, never `--no-verify`). Functions:

- `deployStatus(projectPath)` -> { repoRoot, branch, ahead, changedFiles[],
  hasPreviewBranch, prodBranch, previewBranch }. Read-only.
- `deployPreview(projectPath, { message, previewBranch='visual-preview',
  prodBranch='main' })`:
  1. cd repo toplevel.
  2. `git add -A`; if there are staged changes -> `git commit -m message`
     (if nothing changed, skip commit and just (re)push current HEAD).
  3. `git push -f origin HEAD:<previewBranch>`  (force ONLY the throwaway
     preview branch — never main).
  4. return { ok, committed, sha }.
- `promote(projectPath, { prodBranch='main' })`:
  1. cd repo toplevel; refuse if current branch !== prodBranch.
  2. `git push origin <prodBranch>`  (NO force; non-fast-forward -> surface error).
  3. return { ok, pushed }.

Safety invariants:
- Force-push allowed ONLY to the preview branch; main is a plain push.
- promote refuses unless on the prod branch and surfaces non-fast-forward errors.
- Every action returns captured stdout/stderr; errors are shown, never swallowed.

## IPC + preload
main.js: `visual:deployStatus`, `visual:deployPreview`, `visual:promote`.
preload.js: `visualDeployStatus`, `visualDeployPreview`, `visualPromote`.

## Config (per project; reuse existing pattern)
- `visualProdUrl` (exists) — Live source.
- `visualPreviewUrl` (new) — Preview source; user pastes once (stable branch
  alias URL). Optional `visualPreviewBranch` / `visualProdBranch` overrides;
  default to `visual-preview` / `main`.

## UI (VisualView.jsx)
- Source toggle becomes Local | Preview | Live. Preview loads visualPreviewUrl
  (with a "+ Preview URL" setter mirroring the prod URL setter).
- "Deploy to Preview" button (shown on Local/Preview). "Go Live" button (shown
  once a preview exists / on Preview source).
- Confirm dialog: lists changedFiles, editable commit message, target; Confirm /
  Cancel. Separate concise confirm for Go Live ("pushes main -> live on <url>").
- Deploying state (spinner + streamed result). On preview success -> switch to
  Preview source. On Go Live success -> refresh Live after a short delay.

## Test (must NOT touch pocket-cologne's real remote)
1. `npm run build` exits 0.
2. Unit-exercise deploy-service against a TEMP git repo with a bare local remote:
   - status reports changed files; preview commits + force-pushes preview branch;
     promote pushes main; promote refuses off-branch; non-fast-forward surfaces.
3. `node --check` on changed electron files.
4. In-app smoke (manual, by Carson): buttons render, confirm dialog shows files,
   cancel is safe. Real deploy is his to press.

## Risks
- Pushing to GitHub is real + outward. Mitigation: confirm dialogs, preview-first,
  force only on throwaway branch, promote never forces, all behind explicit press.
- `git add -A` stages the whole repo. Mitigation: confirm dialog lists every file
  so nothing ships unseen.
- Multiple previews stack commits on main. Acceptable for v1 (linear history);
  squash later if desired.

## Scope guard
LOCAL ONLY for the Dobius+ app code (no push of dobius-plus to GitHub). The
Deploy button is the ONLY thing that pushes a website to GitHub, and only when
Carson presses it.

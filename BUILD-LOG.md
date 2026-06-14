# Board View — Build Log

## Task 0.1: Pre-flight + Branch
- **Status**: Complete
- **Time**: 2026-02-23 23:04 EST
- **Actions**: Created branch `build/board-view`, infrastructure files
- **Build**: PASS

## Scaffolding snapshot — 2026-06-13
- **App version**: 1.0.22 (package.json)
- **Branch**: `feature/multi-account-cli-path`
- **Last commit**: `d082675 feat(accounts): add per-account CLI path for Claude accounts`
- **Uncommitted (in-flight feature)**: 27 files — 21 modified + 6 untracked (excludes the newly added `.claude/` dir). Note: this is the real working-tree count today; prior docs cited "26".
- **Current state**: Working tree is dirty with an in-flight dashboard feature (Costs/Prompts/Search/ChangeFeed + `file-change-service.js`). Scaffolding only — `.claude/settings.json` created, lessons/handoff updated. No code touched, nothing committed.

## Visual: Preview / Go-Live deploy buttons — 2026-06-13
- **Branch**: `feature/visual-deploy-buttons` (off `feature/visual-webroot-autodetect`)
- **Commit**: `a756709`
- **What**: Two git-based deploy actions in the Visual window so a website goes from local edits to live without leaving Dobius+. **Deploy to Preview** = `git add -A` + commit + force-push the throwaway `visual-preview` branch (Vercel builds a preview URL); production untouched. **Go Live** = plain `git push origin main` (host auto-deploys public). Both behind a confirm dialog. Generic for any git+Vercel website project; URLs set once per project.
- **Files**: `electron/deploy-service.js` (new), `electron/main.js` (+3 IPC), `electron/preload.js` (+3 bindings), `src/components/shared/VisualView.jsx` (Preview source + buttons + confirm/result overlay), per-project `visualPreviewUrl`.
- **Safety (enforced in code)**: force-push ONLY ever targets the preview branch — refuses when `previewBranch === prodBranch` so main can never be force-pushed; promote never forces and refuses unless on the prod branch (non-fast-forward surfaces); all git via `execFile` (no shell); branch names sanitized; commit message options-terminated (`--`); every result surfaces stderr.
- **Build**: PASS (`npm run build`, 2.75s) + `node --check` on all electron files.
- **Verify**: deploy-service exercised against a throwaway temp repo + bare remote — preview leaves remote `main` at v1 (production untouched), promote pushes main to v2, promote refuses off prod-branch, branch-name injection sanitized to default, `previewBranch==main` refused (main untouched), dash-leading commit message commits cleanly. Real GitHub never touched in testing.
- **Review**: `code-reviewer` subagent (Opus) — found 1 critical (force-push could hit main if preview branch misconfigured to equal prod) + 1 hardening (commit-message option terminator); both fixed and re-verified. Rest clean.
- **Status**: Local only. Dobius+ app code NOT pushed to GitHub. The Deploy button is the ONLY thing that pushes a website to GitHub, and only when Carson presses it.
- **Open**: needs a fresh app build (`./build-and-install.sh`) to use; preview URL must be pasted once per project (no Vercel API to auto-discover it).

## Visual: auto-detect web root — 2026-06-13
- **Branch**: `feature/visual-webroot-autodetect` (off `feature/auto-mark-task-done`)
- **Commits**: `129c0ec` (committed the prior in-flight auto-mark-task-done feature first, per Carson) → `8bb8b16` (this change)
- **What**: `electron/visual-server.js` now resolves the web root via `resolveWebRoot()` — root `index.html` wins (existing projects unchanged), else probes `website/public/site/www/docs/dist/build/out`. Lets the Local side of the Visual phone preview serve any website kept in a subfolder. Goal: edit locally, see it on Local, then push to Live separately. Generic across all website projects, no per-project config.
- **Build**: PASS (`npm run build`, 2.8s)
- **Verify**: Started the real server module against `pocket-cologne` → `/` 200, `/css/design-system.css` 200, `/js/error-reporter.js` 200, `/about.html` 200, missing→404, reload snippet injected, 40 pages listed, clean shutdown. resolveWebRoot spot-checked: pocket-cologne→website/, dobius-plus/slimject-web/simple-safe-cloud→root.
- **Review**: `code-reviewer` subagent (Opus) — clean, no issues introduced, regression safety confirmed. Noted one pre-existing (not introduced) path-traversal in the HTML middleware; left out for scope.
- **Status**: Local only. NOT pushed to GitHub, no PR, no deploy (per Carson). Awaiting his call to push.
- **Lesson**: The on-demand Local/Live Visual preview already existed end-to-end; the only gap for non-root sites was the served directory. Auto-detect beat adding per-project config/UI.

## Auto-mark Tasks-panel item done from a terminal — 2026-06-13
- **Branch**: `feature/auto-mark-task-done` (off `c337b2f`)
- **What**: New `dobius-task-done` CLI + `/taskDone` bridge endpoint. When Claude finishes a task in a terminal it ticks the matching item in the top-right Tasks panel, live. LOCAL ONLY — never calls the Asana API (Asana stays a manual close, per the safety rule).
  - `electron/tasks-service.js`: `completeTaskByRef(projectPath, ref)` resolves by id / asanaGid / fuzzy title (pending-only, single unambiguous match, returns `candidates` on ambiguity). `tasksPath()` now normalizes (`path.resolve` + `~` expand) so the CLI's path and the renderer's `currentProjectPath` encode to the same file.
  - `electron/voice-bridge.js`: `handleTaskDone` + `dobius-task-done` script (CLI_VERSION 7→8), broadcasts `tasks:updated` to all windows. `projectPath` optional — defaults to `pwd`. Uses `curl -sS` (not `-fsS`) so the 4xx JSON body reaches the caller.
  - `electron/preload.js`: `onTasksUpdated(cb)`. `src/components/shared/TasksDropdown.jsx`: subscribes + reloads live. `electron/main.js`: Conductor/auto-mode prompt now calls `dobius-task-done` after verifying a task.
  - `~/.claude/CLAUDE.md`: added a global note so hand-driven terminal sessions also call it.
- **Build**: PASS (`npm run build`, 2.9s) + `node --check` on all 4 electron files. Reinstalled via `build-and-install.sh`.
- **Review**: `code-reviewer` subagent (Opus) — flagged (1) projectPath encoding mismatch and (2) short-title reverse-match collision. Both fixed (normalization; reverse match gated to titles ≥6 chars). Safety confirmed: no Asana API on the completion path.
- **Verify**: Live end-to-end against `pocket-cologne`: ran `dobius-task-done "Web changes"` in a terminal → bridge `ok:true`, JSON flipped, panel badge 3→2, "Web changes" moved into DONE with checkbox + strikethrough (visually confirmed). Guards tested: ambiguity→candidates, no-match→clean error, idempotent re-run. Asana untouched. Test task restored to pending afterward.
- **Status**: Local only. NOT committed/pushed, no PR (awaiting Carson).
- **Lesson**: `build-and-install.sh`'s graceful `osascript quit` is eaten by the app's double-Cmd+Q quit guard, so the OLD instance survives and macOS `open` just refocuses stale code (CLI scripts stayed v7, new bridge route absent). Had to force-kill the old PID, then relaunch, before v8 installed. Worth hardening the script to confirm the process is actually gone before `open`.

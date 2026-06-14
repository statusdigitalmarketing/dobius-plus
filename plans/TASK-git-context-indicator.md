# TASK — Git Context Indicator in the window header (plan, no code)

**Status:** PLAN ONLY — no code written. Awaiting approval.
**Author:** Claude (Opus 4.8)
**Created:** 2026-06-14
**Branch (when built):** `feature/git-context-indicator`
**Size:** Small (one component edit + one theme variable + one relabel)

---

## What

Show the active tab's git context in the **visible** window header (`TopBar`), color-coded:

```
[project] · [tab] · [branch] · worktree      (worktree → teal)
[project] · [tab] · [branch] · branch         (regular → neutral)
[project] · [tab] · detached                  (detached HEAD)
(nothing)                                      (not a git repo → hidden)
```

## Why

The branch/worktree status already exists but is only in the OS window title, not the in-app header. Putting it in `TopBar` makes "am I on a worktree or the real branch?" glanceable, which matters because Dobius+ runs build work on worktree branches and a wrong-branch commit is a real risk.

---

## Current state (verified anchors)

| Piece | Location | Status |
|---|---|---|
| Worktree + branch detection | `electron/git-service.js` `getGitStatus()` 35-75 (worktree via git-dir≠common-dir, 58-63) | EXISTS |
| Store fields | `src/store/store.js` `currentBranch`, `currentIsWorktree` | EXISTS |
| Refresh effect (cwd-aware, 20s poll, tab-focus, new-session) | `src/components/Project/ProjectView.jsx` 73-98 | EXISTS |
| Window-**title** indicator | `ProjectView.jsx` 101-107 | EXISTS |
| Visible header component | `src/components/shared/TopBar.jsx` (center block 62-74 already renders `project · tab` with `·` + `var(--dim)`) | EXTEND HERE |
| Theme variables | `src/lib/themes.js` (10 themes) | ADD `--git-worktree` |

**Decision already made (see spec review):** reuse existing `isWorktree`; do NOT add a `git worktree list --porcelain` call.

---

## Changes (3 small edits)

**1. `src/lib/themes.js` — add a `--git-worktree` variable to all 10 themes.**
A teal tuned per theme (not one hardcoded hex). Neutral branch reuses `var(--dim)`. Optional: a `--git-detached` (amber) for the detached case; if not added, detached reuses `var(--dim)` with italic.

**2. `electron/git-service.js` — detached HEAD relabel** (one line in `getGitStatus`).
When `git rev-parse --abbrev-ref HEAD` returns `HEAD`, set a flag (`detached: true`) or normalize `branch` to `''` + `detached:true`. Prefer returning `{ ...status, detached: branchOut.trim() === 'HEAD' }` so the UI decides the label. Then `ProjectView.jsx` stores `currentDetached` (new store field) alongside branch/worktree.

**3. `src/components/shared/TopBar.jsx` — render the pill** in the center block after `activeTabLabel`:
- Read `currentBranch`, `currentIsWorktree`, `currentDetached` from the store (same selectors `ProjectView` already uses).
- If no branch and not detached and not a repo → render nothing (hide).
- Else render: `· <branchOrDetached> · <worktree|branch>` where:
  - branch text = `currentDetached ? 'detached' : currentBranch`
  - kind text = `currentIsWorktree ? 'worktree' : 'branch'` (omit kind when detached, or show `detached` once — final copy decided in build)
  - color: worktree → `color: var(--git-worktree)`; regular/detached → `var(--dim)`.
- Keep it inside the existing `truncate max-w-96` span so long branch names don't break layout.

**Layout note:** the center span already shows `project · tab`. Appending `· branch · worktree` can get long; the existing `truncate` handles overflow. If it feels cramped in testing, fall back to rendering the git pill as a separate `no-drag` element just left of the right-hand button cluster. Decide visually during build.

---

## Refresh triggers — already covered, confirm don't rebuild

Spec asks for refresh on tab focus, directory change, new session. The existing effect (`ProjectView.jsx` 73-98) already does all three: it keys on `activeTabId` (tab focus + new session) and reads the active tab's live `cwd` via `terminalGetCwd` on a 20s interval (directory change, ≤20s lag). **No new polling needed.** Only add `currentDetached` to what the effect writes (change 2 above feeds it).

Optional nicety (not required): also refresh immediately on terminal focus event instead of waiting up to 20s — only if the 20s lag feels off in testing.

---

## Verify

- `npm run build` exits 0 (JS/Vite project — no tsc).
- Manual, in a **project window** (not launcher — header git needs `currentProjectPath`):
  1. Regular branch repo → pill shows `· <branch> · branch` in neutral.
  2. `cd` a tab into a linked worktree → within 20s pill flips to teal `· <branch> · worktree`.
  3. `git checkout <sha>` (detached) → pill shows `detached`.
  4. `cd` into a non-repo dir → pill disappears.
  5. Switch themes → teal stays legible in all 10 (that's why it's a variable).
- **Screenshot proof** in a fresh window per the screenshot house-rule; attach worktree + branch + detached states.

## Risks

- **Header crowding** on long branch names — mitigated by existing `truncate`; fallback layout noted above.
- **Theme legibility** — adding the var to all 10 themes (not hardcoding) is the mitigation; verify step 5 covers it.
- **Detached edge cases** (mid-rebase, unborn branch on fresh repo) — `getGitStatus` already returns `isRepo`; treat unborn (`HEAD` with no commits) as hidden or `no commits`; confirm during build.

## Out of scope

Dirty/ahead-behind counts in the header (already available from `getGitStatus`, but that's a separate enhancement); clicking the pill to open the Git panel (nice later, not now).

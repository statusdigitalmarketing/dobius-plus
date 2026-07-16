# TASK — Auto-mark a panel task done when Claude finishes it

## What
When Claude finishes a task in a terminal, the matching task in the top-right
Tasks panel (`TasksDropdown`) auto-checks itself, live, without reopening the
panel. Local panel only — never touches Asana (global house rule: never
auto-close Asana tasks).

## Why
Carson works tasks (his own build-lane tasks + reviewing Sam's) in the terminal.
Today he has to manually tick each one in the panel. This closes the loop:
Claude reports completion → panel updates itself.

## How (seam = existing dobius-* CLI bridge)
1. `tasks-service.js` — add `completeTaskByRef(projectPath, ref)` that resolves a
   task by id, asanaGid, or fuzzy title (case-insensitive substring, prefers
   an unambiguous single match among *pending* tasks) and sets `done:true`.
   Returns `{ ok, task }` or `{ ok:false, error, candidates? }`.
2. `voice-bridge.js` — new `/taskDone` endpoint + `dobius-task-done` CLI script
   (bump CLI_VERSION). Script usage: `dobius-task-done <projectPath> "<title-or-gid-or-id>"`.
   Endpoint calls `completeTaskByRef`, then broadcasts `tasks:updated` to all
   windows so the panel refreshes.
3. `main.js` — broadcast helper already exists (`sendToWindow`/getAllWindows).
   Add a `broadcastTasksUpdated(projectPath)` used by both the IPC update path
   and the bridge. Simpler: voice-bridge imports BrowserWindow and sends
   `tasks:updated`. Add terminal system-prompt line instructing Claude to call
   `dobius-task-done` when it finishes a panel task.
4. `preload.js` — expose `onTasksUpdated(cb)` listener.
5. `TasksDropdown.jsx` — subscribe to `onTasksUpdated`; reload when the event
   matches the current project (or always). Keep working when panel is closed
   (state already lives in component; just call `load()`).

## Test
- `npm run build` exits 0.
- Manual: run `dobius-task-done <project> "<some task title>"` from a terminal;
  the panel's matching task flips to Done live; Asana untouched.
- Ambiguous/no-match returns a clear error string (no silent wrong-task check).

## Risks
- Wrong-task match on fuzzy title. Mitigate: only match *pending* tasks; require
  a single unambiguous match; return candidates on ambiguity instead of guessing.
- Asana safety: endpoint must NEVER call the Asana API. Local JSON only.
- Live refresh races: reload is idempotent; last-write-wins is fine here.

## Review (post-implementation)
- `completeTaskByRef`: exact id/gid match is idempotent; title match restricted
  to PENDING tasks and requires a single unambiguous hit, else returns
  `candidates` instead of guessing. Verified no silent wrong-task check.
- Asana safety confirmed: the new endpoint + service path call NO Asana API.
- `npm run build` exits 0; `node --check` passes on all 4 changed electron files.
- CLI uses `-sS` (not `-fsS`) so the 4xx JSON body (error/candidates) reaches
  Claude for self-correction — a deliberate divergence from sibling scripts.
- Files changed: electron/tasks-service.js, electron/voice-bridge.js,
  electron/preload.js, electron/main.js, src/components/shared/TasksDropdown.jsx.

## Not done (needs Carson)
- For a NORMAL terminal session (Carson working a task himself, not via the
  Conductor), Claude only auto-checks the panel if told to call
  `dobius-task-done`. The in-app prompt change covers the Conductor/auto-mode
  flows; for hand-driven sessions, add a one-liner to global or project
  CLAUDE.md. Offered separately.
- Not committed/pushed (workspace is local-first; awaiting Carson's go).
- Live test requires a rebuild+install so the v8 CLI script + bridge route load.

# TASK-NOTES.1 — Per-project Notes / Memory dashboard tab

## What
Add a "Notes" dashboard tab where the user AND terminal agents can take notes
during sessions, scoped to the current project. Notes persist to a plain markdown
file in the project folder so the Claude Code agent running in the terminal can
read and append to it with its normal file tools.

## Why
The user wants durable, project-scoped memory that both they and agents can grow
over time ("agents always evolving and always have memory"). Storing in Electron
config.json (like Prompts) would hide the notes from the terminal agent, defeating
the goal. A file in the project cwd is visible to both sides.

## Design
- **Storage:** `<project>/.dobius/NOTES.md`. `.dobius/` added to project `.gitignore`.
- **IPC:** `notes:read` / `notes:write` in `electron/main.js`, reusing the existing
  symlink-resolved containment helpers. Locked to basename `NOTES.md` inside a
  `.dobius` dir under a registered project root.
- **Preload:** expose `notesRead(projectPath)` / `notesWrite(projectPath, content)`.
- **UI:** `src/components/Dashboard/Notes.jsx` — quick timestamped add-note box
  (appends `## YYYY-MM-DD HH:MM (carson)` entries) + full markdown editor with live
  preview over the same file, manual save + Cmd+S. Scoped to `currentProjectPath`;
  friendly empty state in launcher window (no project path).
- **Register:** add `{ id: 'notes', label: 'Notes' }` to DashboardView TABS + content.
- **Agent memory:** add a "Project memory" pointer to project root `CLAUDE.md`.

## Test
- `npm run build` exits 0.
- Tab appears, loads/creates `.dobius/NOTES.md`, quick-add appends a dated entry,
  editor saves, preview renders. Agent can `cat .dobius/NOTES.md` in the terminal.

## Risks
- Path-containment must be correct (reuse proven helpers, don't loosen them).
- Project-window only (launcher has no `currentProjectPath`) — handle empty state.

## Estimate
~4 files changed + 1 new component.

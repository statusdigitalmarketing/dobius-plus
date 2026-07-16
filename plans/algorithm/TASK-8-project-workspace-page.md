# TASK-8 — Project workspace: click a project, enter a place

**Verdict:** KEEP — this is the "holy shit" UX ask. Carson (twice, verbatim):
"I don't know which project is what within that repo. Or if it's attached to a
repo… there's no real management here." A project must be a PLACE you enter,
not a filter you apply.

## What
Clicking a project in the Manager rail opens a project workspace view (replaces
the list area, breadcrumb back to All):
- **Header:** project name; if it matches a real repo (store `repos` by
  displayName) show the repo path + an "Open in workspace" action that jumps to
  that worktree; badge if NOT attached to any repo (answers "is it attached?").
- **Mail section:** filed threads, newest first (sender, subject, snippet,
  Quick Look, open link).
- **Docs section:** filed docs grouped by folder family (icons, previews).
- **Untriaged suggestions strip:** bundles/folder-families whose name fuzzy-
  matches this project — one click files the family here (reuses TASK-5's bulk
  classify).
- **Agent action:** "Copy brief" (TASK-7 output to clipboard) — the human path
  to handing context to any session, before auto-injection exists.

## Concrete simplification chosen
Rung: **reuse.** Same virtualized row components, same rail, same classify IPC,
TASK-7's brief for the copy action. This is composition, not new machinery —
the only new logic is the repo displayName match (exact + case-insensitive; no
fuzzy library).

## Acceptance test
- Click `dobius-plus` in the rail → workspace shows its filed docs and mail in
  sections, header shows the repo path (it exists in the store), "Copy brief"
  puts TASK-7 markdown on the clipboard.
- A project with no matching repo shows the "not attached to a repo" badge.

## Estimate (rough — not measured)
~1–1.5 days.

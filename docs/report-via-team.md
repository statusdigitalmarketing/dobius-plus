# Report a problem through a teammate (design, 2026-11-18)

## Why

Brett (Asana 1220678819527538): "Report a problem" answered "Not sent: this computer's GitHub login cannot see the
reports repo." Reports are filed with the reporter's own `gh` login into the private
`statusdigitalmarketing/dobius-plus-reports` repo, so only people with access to that repo can report. Sam asked for
a path that does not depend on the reporter's GitHub login.

## Options considered

1. **A web endpoint (dobepros.com) that files issues with a server-side token.** Works for anyone, but needs a new
   GitHub token on the server (a new secret, created by Sam) and a public write endpoint to defend from spam. Not now.
2. **The team link (chosen).** Teammates' Dobius installs are already linked to Sam's with the end-to-end encrypted,
   signed team channel (docs/team-communicator.md). The reporter's Dobius sends the report to a linked teammate's
   Dobius, and THAT install files it with its own `gh`. No new secret, no new endpoint, and only linked installs can
   send (signature checked, rate limited 20/min and 300/day per peer, 48 KB bodies).

## Shape

### Sender (the reporter)

- `report:submit` tries the local `gh` first, unchanged. When it answers `no-gh` or `no-access`, and this install has
  at least one linked, enabled teammate, the report goes over the team link instead.
- Message kind `report` (new). Text = the built issue (`title`, blank line, `body`), capped at the team text limit
  (8000) by trimming the error-log section first, then the description.
- **Who gets it:** one teammate at a time, in link order (oldest link first). The receiving install answers through
  the existing status back-channel: `done` with the issue URL as the note when it filed it, or `failed` with a
  reason when it cannot (its `gh` cannot see the repo either). On `failed`, the sender sends the same report to the
  next untried teammate (a new message id, `reportOf` linking the attempts). When every teammate failed, the row
  says so and offers Copy. This keeps a report from landing in the inbox of a teammate who cannot file it.
- The dialog answers at once: "Sent to <teammate>'s Dobius to file. Tasks > Team shows when it is filed." The text
  is still copied to the clipboard, as today, so nothing is lost if every route fails.
- An older teammate Dobius refuses the unknown kind (403 'fields'). That counts as `failed` for the hand-on rule.

### Receiver (the teammate who files)

- A `report` message is NEVER typed into a tab and never enters the delivery queue (no orchestrator, no Auto-route).
- It is filed with the receiver's own `gh issue create -R <reports repo>` (execFile, no shell), title from the first
  line (capped like today's titles), body = the rest plus a line "Sent by teammate <verified sender name>" (the name
  is the receiver's own record of the signer, never text from the message).
- One filing at a time, at most 10 per peer per hour (on top of the team rate limit). Over that: `failed`
  ("too many reports, try later").
- Row states: `filing`, then `filed` (note: URL) or `not filed` (note: reason). A row left `filing` by a crash is set
  to `not filed` at start, never re-filed, so a report cannot become two issues.
- Rows of kind `report` show in Tasks > Team as "Report from <name>" with the issue link, and are hidden from the
  orchestrator delivery views.

## Accepted

- A report the receiver filed but whose `done` status never reaches the sender (the sender is offline for days)
  stays "sent" on the sender. The issue exists; only the confirmation is missing.
- Two installs of the same person that can both file get at most one report each in turn, never both at once.

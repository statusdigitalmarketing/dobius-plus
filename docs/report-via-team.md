# Report a problem through a teammate (design, 2026-11-18, revised after the Codex design review)

## Why

Brett (Asana 1220678819527538): "Report a problem" answered "Not sent: this computer's GitHub login cannot see the
reports repo." Reports are filed with the reporter's own `gh` login into the private
`statusdigitalmarketing/dobius-plus-reports` repo, so only people with access to that repo can report. Sam asked for
a path that does not depend on the reporter's GitHub login.

## Options considered

1. **A web endpoint (dobepros.com) that files issues with a server-side token.** Works for anyone, but needs a new
   GitHub token on the server (a new secret, created by Sam) and a public write endpoint to defend from spam. Not now.
2. **The team link (chosen).** Teammates' Dobius installs are already linked to Sam's with the end-to-end encrypted,
   signed team channel (docs/team-communicator.md). The reporter sends the report to ONE linked teammate's Dobius,
   which files it with its own `gh`. No new secret, no new endpoint, and only linked installs can send (signature
   checked, team rate limits apply).

## Sender (the reporter)

- `report:submit` tries the local `gh` first, unchanged. When it answers `no-gh` or `no-access`, the answer also
  lists the linked, enabled teammates (`teammates: [{ id, name }]`).
- The dialog then offers "Send it through a teammate's Dobius" with a picker (only when there is more than one) and
  one button. The person chooses; nothing goes to a teammate without that click. The report is still copied to the
  clipboard, as before, so nothing is lost if the teammate never files it.
- `report:relay` builds the same report (same builder, same scrubbed log) and sends it as team message kind
  `report`: first line the title, then a blank line, then the body. It is under the team text limit by construction
  (description 4000, log 40 lines); if not, the log section is left out.
- **Exactly one teammate, no automatic hand-on.** An unsigned refusal cannot tell "an older Dobius refused the kind"
  from "it filed it and the receipt was lost", so moving on to a second teammate could file the report twice. A
  report that a teammate does not file stays in Tasks > Team for the person to see.
- **A signed status settles the row.** The receiver reports `done` (note: the issue URL), `failed` (note: why) or
  `needs attention` (it may or may not have filed it). A signed status about a message proves it arrived, so
  `receiveStatus` marks the out row `delivered` whatever its transport state was, and an attempt still in flight
  cannot set it back to `queued`. This applies to every kind: a status is never sent about a message that did not
  arrive.
- A report row offers Retry (same id: the receiver dedupes by id) but never "Send again" (a new id could file a
  second issue). Its stages read "filed", "not filed" and "may be filed"; "Open issue" appears only when the note is
  an issue URL in the reports repo.
- An older receiver refuses the unknown kind: the row retries until its 24 h deadline, then reads unconfirmed, and
  the report is still on the clipboard. Accepted (both ends update with the same release).

## Receiver (the teammate who files)

- A `report` message is NEVER typed into a tab and never enters the delivery queue. It is stored with state
  `filing` and filed by the receiver's own `gh issue create -R <reports repo>` (execFile, no shell, no prompt).
- One filing at a time, and at most 10 per teammate per hour (in memory, on top of the team limits). Over that: not
  filed, "too many reports in the last hour".
- Title: the first line, control characters removed, capped at 120, and `[report] ` added when missing. Body: the
  rest, plus a footer naming the sender by FINGERPRINT (`Relayed by a linked teammate's Dobius, fingerprint
  XXXXX-XXXXX.`) and the name only as "their Dobius calls itself ...": a linked teammate chooses its own name, so
  the name is never the attribution. Plus a marker `<!-- dobius-relayed-report <fingerprint>/<message id> -->`.
- Row states: `filing` (in flight: never evicted at the 500-row cap), `filed` (note: URL), `not filed` (note: why),
  `check reports` (Dobius quit during a filing: the issue may exist; needs a person, kept for the attention window).
  A row still `filing` at start-up becomes `check reports` and is never filed again, and the sender is told
  `needs attention`.
- A report row shows "report" next to the name, the filed issue with an Open button, and no "Send to orchestrator".

## Accepted

- A report the receiver filed whose `done` status never reaches the sender (offline for days) stays "delivered" on
  the sender. The issue exists; only the confirmation is missing.
- `check reports` needs a person to look in the repo; Dobius does not search it (GitHub's search index lags).

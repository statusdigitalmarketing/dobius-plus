# My Day

Sam, 2026-11-05: a central place for each team member, coupled with SamKnows, so everyone's life is organized and follow-ups do not get lost. Decided by Sam: private data stays on each person's own Mac, and the order is Sam, then Brett and Bryan.

## What shipped first: Today (Tasks dropdown)

Up to 15 Inbox cards that look pressing, a count of everything left out with See all, and a separate section for what SamKnows noticed. Code: `electron/today.js`, `TodayList` in `src/components/shared/TasksDropdown.jsx`. Reads only this Mac.

The rule that matters most: never read as finished while something is hidden. So it never says nothing needs attention, only what the board holds ("No open cards on the board"). A source that is down, a mailbox it cannot read, or a board that has not checked lately each say so.

## What the data showed (2026-11-05, counts only)

Inbox: 212 open, 90 marked high, 190 inside the pressing windows, so due date and priority alone cannot pick a real top 15. SamKnows: 1,484 pending action items, 750 pending follow-ups, 10,065 auto-dismissed, none ever completed, and 1,427 of the action items are unreviewed iMessage extractions. They are candidates, not obligations, so they are never ranked with the Inbox.

## Cut from this step by the Codex design audit

Bills (renewal predictions, not bills: no invoices, no paid state). Fleet rows (no field says who acts next). Merging duplicates, and fuzzy "possibly the same" (another way to hide work). Snooze, until deadlines and changes can wake an item. Done on SamKnows rows, until writes check expected state.

## Shipped next: Today comes to you (2.2.4, branch feat/phone-today)

- Phone: a Today screen (Claude's picks with reasons, Done, Snooze, Bring back,
  See all with search) and a Settings screen, from new buttons on the phone's
  home screen. Protocol in `docs/mobile-ws-protocol.md`.
- Today alerts (`electron/today-nudge.js`): the first five at the morning time,
  the next five once those are all done or snoozed, one reminder after three
  hours, and new or returning cards at most hourly. COUNTS ONLY ("5 things to
  do, 1 overdue, 2 due today"): cards can name patients and customers, and a
  nudge lands on a lock screen and in Messages history. Channels: Mac
  notification (click opens Today), iMessage to yourself (skipped when the
  bridge's trigger prefix is empty or would match), phone push (Safari
  home-screen web app only; the App Store app has no push yet, that needs APNs).
- Only the installed app nudges, one process at a time (`today-nudge.lock`),
  and the decision is saved before sending, so a nudge never goes twice.
- Known limit, for Sam to accept or not: two Dobius processes on one Mac
  sharing the same userData at the same time (Dobius has no single-instance
  lock). Dev runs never nudge, and macOS opens the installed app once, but if
  two copies did run together, Codex found they could still both send one
  nudge (a three-way stale-lock race), keep different snooze caches (a Bring
  back in one could undo a newer snooze from the other), and read different
  iMessage bridge prefixes. Closing it properly means a real single-instance
  lock for the whole app.

## Next

1. Better picking, because rules cannot do it. Candidate: the same Claude judging the board picks the day's short list with a reason per card.
2. Look at real SamKnows output with Sam. SamKnows main (1ea8c3a0, not released as of 2026-11-05) fixes the dedupe that dropped repeat requests, and adds an optional expected-state check: send `expectedExtractedAt` on /action-items/:id/complete and /dismiss, `expectedDetectedAt` on /follow-ups/:id/fulfill, 409 if the row changed. A reopened row keeps its id and gets a new timestamp, so rows here must key Done on that value. Offer Done on these rows only after that is released and Sam has seen real output.
3. Phone, through the paired connection to this Mac only.
4. Drafted follow-up nudges that send only on a click.
5. Brett and Bryan: everyone needs a current Dobius first, and SamKnows is not assumed.

## Test harness

An isolated instance never reads real SamKnows data: `DOBIUS_SAMKNOWS_PORT` points it at a stand-in, and with none set it goes nowhere. `DOBIUS_INBOX_DIR` and `DOBIUS_INBOX_PORT` do the same for the board.

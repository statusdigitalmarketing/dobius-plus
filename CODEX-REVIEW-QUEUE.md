# Codex review log: feat/desktop-chat

Codex is available (verified 2026-10-28). The commits below were held for the
house-rule bugbot pass; it is now running. Nothing on this branch is pushed or
released.

| Commit  | What |
|---------|------|
| 2c5be4e | Desktop Chat round 6 fixes |
| 6854e4c | Round 6 reviewer fixes (renderer + integration) |
| e8451ae | Full selector prompts, option detail, capped mobile card, fingerprint fix |
| afc6c68 | Collapse long messages, skill previews (desktop + mobile) |
| db548e2 | Drop api-request-blob records in parseJsonl / streamJsonl |
| 6fc1a61 | Phase 2 typed transcript blocks (desktop + mobile) |

## Round 8 (2026-10-28): four lenses over the six commits

Lenses: 1 selector guard + submit queue, 2 transcript data contract,
3 renderers, 4 break-the-guards + silent reverts. Findings, all fixed in the
working tree for round 9:

- Critical (lenses 1 and 4): selector fingerprint collision. Two prompts can
  look identical (beyond 40 context rows, regex fallback without context,
  escape-only repaints). Token now includes the raw PTY output count, so a card
  answers only if nothing reached the tab since it was read. The phone now
  answers through the same guard (`selectorKey`); it had no stale check at all.
- High: a foreign Enter then Ctrl+U reported a sent paste as "not sent".
- High: a user record with tool results AND text lost the text in blocks mode.
- High: the compaction chip changed the legacy payload (now blocks mode only).
- Medium: capText skipped the detach for short trimmed strings.
- Medium: one tool-heavy turn could become a single multi-MB row.
- Medium: a History reply for the same session overrode the Chat view.
- Medium: index keys moved collapse state between rows as the window slid.
- Medium: copy omitted text in blocks rows; malformed blocks could crash.
- Low: a second identical send got no echo if the first landed first.

Accepted, safe failure: any PTY output (spinner, progress row) makes an open
card stale, so a click is refused and the card re-reads. Idle Claude Code is
silent on a prompt, so this does not block real answers.

Accepted residual (Low, cosmetic): if an identical send ahead of this one
fails after this one started, this one's echo can show beside its transcript
copy until the 90s echo TTL.

## Round 9 (four lenses over the round 8 fixes)

Fixed:
- Critical (three lenses agreed): the phone kept the answer token in a ref
  that a new prompt overwrote before its card rendered, so a tap on the old
  card carried the new prompt's token. The token now rides on the rendered card.
- High: a tap while reconnecting was dropped (`selectorKey` now queued; a
  stale token is refused on arrival).
- High: a key Claude ignored left the card disabled forever and the App Store
  build's card vanished. A 3s quiet now settles the tab (the token still
  carries the output count), and unsettled reads carry the prompt for display.
- High: a frame with Enter plus Ctrl+U counted as our own erase.
- Medium: unbounded unsettled re-probe timers on the phone.
- Medium: text merged past the content cap was lost; results attached after a
  merge could push a row past the size cap.

Accepted (Low, flagged by two lenses): a desktop echo can linger up to 90s
when an identical send ahead of it fails (same residual as above).

## Added after round 9 (Sam's request)

Claude's live spinner in both chat views: the real verb ("Whirlpooling"),
the glyph cycle, elapsed time and tokens, ticking between polls. Plus a
"new messages" pill when scrolled up and a pulse on the tool step that is
running in the live turn.

## Round 10 (three targeted lenses: selector guards, data + activity, UI)

Fixed:
- Critical: option buttons were keyed by option number, so a press begun on
  prompt A could complete as a click on prompt B. Cards are now keyed by what
  they say (shared selectorKey), so a new prompt remounts the card.
- High: a tap queued while reconnecting was dropped silently if the Chat view
  unmounted first. The token is now the authorization and every tap gets a
  result.
- Medium: the "output not shown" notice could push a row past the cap.
- Medium: incremental spinner repaints left a stale time and token count; the
  activity line now reads the rendered screen.
- Medium: the phone clock rewound when another tab changed; a reading keeps
  its first arrival stamp.
- Medium: a hidden desktop pane kept animating.
- Medium: parallel tools: only the last one showed as running.
- Medium: rows without ids could hide new messages from the pill.
- Low: the pill could stay up after a jump.

## Round 11 (three lenses aimed at the round 10 fixes)

Fixed:
- Critical (two lenses): the card key used only what the card shows, so two
  edit prompts with the same question about different diffs shared a key.
  The key now carries the server fingerprint as well.
- Medium: a stale first reading was never corrected on the phone (signature
  ignored seconds). The signature now flags the reading's source and a
  doubling seconds bucket.
- Medium: a 64KB replay cut inside an escape sequence hid the spinner. The
  cut now backs up to the start of the sequence. (A first attempt skipped
  forward and dropped the spinner itself; its test caught it.)
- Medium: the post-jump hold ignored a real upward scroll; it now ends on any
  upward scroll or when the jump lands.
- Medium: id-less rows "OK" then "OK" looked unchanged; the row fingerprint
  now includes the timestamp.

## Round 12 (three lenses aimed at the round 11 fixes)

Fixed:
- Critical: the fingerprint only sees the last 40 rows of context, so no key
  can be complete. Both views now bind a press to the token it began on and
  refuse a click whose card token differs ("Nothing was sent"). Reproduced
  live on desktop and phone with a stand-in that repaints an identical-looking
  prompt: same button, same fingerprint, click fires. With the guard removed
  the release approves the unseen prompt; with it, nothing is sent.
- Found while reproducing: the desktop card blinked out for ~2.3s on entering
  Chat (the first transcript reply cleared it). Fixed.
- Medium: the activity cache outlived turns while no phone was connected; it
  now clears when none is.
- Medium: the autoscroll write did not end the jump hold, and an older jump's
  timer could cancel a newer jump's hold. Both fixed.

## Round 13 (press guard + scroll/cache lenses)

Fixed:
- Critical (two lenses): holding Space auto-repeats keydown, which
  re-recorded the press on the new card. Only the first keydown counts now;
  verified live (with the filter removed, a held Space approves prompt B).
- Critical: token counters restart with the app, so a token queued before a
  restart could match. Tokens now carry a per-process random id.
- Critical: on an older Mac (no tokens) the phone's press check passed
  trivially. It now requires the very card object the press began on.
- Medium: a click with no pointer or key event (assistive tech) was refused
  forever. It now answers what it shows.
- Medium: an interrupted jump cleared the pill for rows never seen; the
  previous reading mark is restored.

Accepted (Low): on entering Chat, a card read a moment before its session was
replaced can show until the next selector poll; a click on it is refused by
the server's token check.

## Round 14 (press guard + scroll lenses)

Fixed:
- Critical: a Shift keydown during a mouse hold re-recorded the press on the
  new card, and a synthetic click consumed a held mouse press's record. The
  press logic is now one tested helper (shared createPressGuard) with pointer
  and key presses in separate slots; both scenarios are unit tests and the
  separation is sabotage-checked.
- Medium: after a session swap the phone's reading mark was empty, so the pill
  could never show; an empty mark now becomes the baseline.

Accepted (Low, cosmetic): a "New messages" pill when a queued message
disappears with nothing new; a stale pill when collapsing a group makes
everything fit without a scroll event.

## Round 15 (press guard + scroll lenses)

Fixed:
- Critical: a second pointer could overwrite a held pointer's record, and a
  rejected synthetic click could erase a held key's record. The guard now
  tracks what is physically held: a record lives from the first press until
  shortly after the last release, a second press on a different card poisons
  it, and a rejected click clears nothing. Unit tested and sabotage-checked;
  live probes pass for mouse, held Space, a real touch tap, and a click with
  no press.
- Medium: content that loaded while the reader was scrolled up got no pill;
  it now shows "New messages" until they reach the bottom.
- Medium: a queued message at the end hid a tool result landing just above
  it; the reading mark now covers the last three rows.

## Round 16 (press guard + pill lenses)

Fixed:
- Critical: holding Space through a window switch, then releasing it after a
  same-looking prompt replaced the first, answered the new prompt (the blur
  reset erased the held press). A press held through a blur now poisons the
  slot until its release. Unit tested and sabotage-checked.
- Medium: three or more queued messages could hide a tool result above them;
  the reading mark now reaches back to the last non-queued row.

## Round 17 (press guard + pill lenses)

Fixed:
- Critical: a second window switch while the key was still held erased the
  poison from the first. The poison now survives repeated blurs.
- Medium: the queued-row scan had a 20-row cap; 21 queued messages hid the
  result. The cap is gone (the window is already 200 rows).

## Round 18 (press guard + pill lenses)

Fixed:
- Critical: a release timer from an earlier press could clear a later press's
  poison (one shared sentinel). Each poisoning is now its own object.
- Medium: queued messages between two live turns could hide a result in the
  earlier one. The reading mark now signs the whole 200-row window.

## Round 19 (press guard + pill lenses)

Pill lens: No bugs found.

Fixed (press guard):
- Critical: an unrelated key's release could clear a held key's poison.
- Medium: a release lost in another window poisoned the slot forever,
  wedging assistive tech.
The guard now remembers what was held at a blur ("orphans"): only those keys'
own releases (or a fresh press of them) end the poison, unrelated releases
are ignored, and an orphan expires after 10s.

Accepted residual: a key held for more than 10 seconds through a window
switch, then released after a different prompt that looks identical on screen
arrived (another surface answered meanwhile), is no longer tracked. The 10s
bound is what keeps assistive tech from being locked out forever; the
sequence needs a deliberate 10-second hold across a window switch plus a
concurrent answer elsewhere.

## Round 20 (press guard lens)

No bugs found. Both lenses that broke guards (press guard, pill) are clean
on the final state; the data/activity lens was clean of new findings after
its round 12 fix. Committed locally (not pushed, not released).

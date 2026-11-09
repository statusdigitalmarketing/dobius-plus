# t3code second pass: what is left to take

Date: 2026-11-09. Source: github.com/pingdotgg/t3code at `c6ca605630` (main, 2026-11-09), read with
`gh api` only (README, AGENTS.md, docs/user/*.md, docs/internals/*.md and selected files under
apps/web/src). Nothing was cloned, downloaded or run. Licence: MIT, "Copyright (c) 2026 T3 Tools
Inc.". Same attribution rule as the Orca study: ideas are free; adapted code keeps the MIT notice in
a `THIRD_PARTY_NOTICES.md` plus a one-line source header.

## Did we get as much as possible last time? No.

We took two things: the Cmd+P command palette (synonym search, drill-in submenus, Esc goes back,
`>` for actions only; commit b832c71) and the context-window ring in
`src/components/shared/StatusBar.jsx`. This pass found **25 more ideas that fit Dobius+**, so we
have taken about 2 of 27, under 10%. Most of what is left is small: 15 of the 25 are effort S or
S-M (under a day or two).

What changed since the first look: t3code is now a full "agent harness control surface" (web app,
Electron desktop, iOS and Android, a relay) with about 1,900 files in `apps/web/src`. Its chat
(`apps/web/src/components/chat/`, 270 files) is the most polished part, and its user docs
(`docs/user/`, 60 pages) describe the behaviour precisely enough to work as specs.

Not re-proposed: palette, context ring. Already present in Dobius+ and skipped: hold-to-quit hint
(we have `QuitOverlay.jsx`), reopen closed tab (Cmd+Shift+T), optimistic sent messages (ChatPane
`sending`), jump to latest in chat, `>` actions filter.

## Ideas worth taking

Effort: S under a day, M a few days, L a week or more. "Converges" means Orca does the same thing
independently (see `orca-study.md`).

### Chat and composer

**T1. Hold new question cards while the user is typing.** If a permission or question card arrives
while the composer has focus and a key was pressed in the last 1,500 ms, the card is held back, so a
keystroke or Enter meant for the draft cannot answer it.
- t3code: `apps/web/src/components/chat/composerTypingGuard.ts` (`COMPOSER_TYPING_IDLE_MS = 1500`).
- Dobius+: `src/components/Project/ChatPane.jsx` and the phone chat. Our `createPressGuard` in
  `shared/chat-rows.js` protects a press against a card that changed; this protects typing against a
  card that just appeared. Same idea for the terminal: hold Enter from the Chat composer for 1.5 s
  after a selector frame appears in the PTY.
- Value: high (an accidental "Yes, allow" is the worst outcome in the app). Effort: S to M.

**T2. Up arrow recalls sent prompts.** In an empty composer, Up walks back through prompts sent in
this session and Down comes forward; it only takes over while the text is an unedited recalled
prompt and the caret is on the first (or last) visual line.
- t3code: `apps/web/src/components/chat/composerPromptHistory.ts`; `docs/user/composer.md` "Recall a
  sent prompt". Converges with Orca `drafts/use-native-chat-composer-recall.ts`.
- Dobius+: `ChatPane.jsx` composer (it has no ArrowUp handling today). Effort: S. Value: medium-high.

**T3. Resume at reset and Snooze until reset.** When a turn stops on a usage limit, the banner
offers "Resume at reset" (schedules a continue message at the reported reset time, cancelled by any
new message, stop or close) and "Snooze until reset" (hides the tab until then). A setting makes
either the default.
- t3code: `apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx`, `ComposerUsageLimits.tsx`;
  `docs/user/thread-sidebar.md` "Inspect agent work". Converges with Orca
  `native-chat/usage/use-native-chat-usage-limit-auto-continue.ts`.
- Dobius+: the reset time is already known: statusLine `rate_limits.five_hour.resets_at`
  (NOTES 2026-09-17). Banner in `ChatPane.jsx`, tab menu item in `TerminalTabBar.jsx`, scheduler in
  main next to `store.continueTabOnActiveAccount`. Pairs with "Move to another account".
- Value: high. Effort: M.

**T4. Tool-call visibility setting.** Show all / Hide successful (show while running, keep only
failures) / Hide all (show "Thinking") / Zen (only your message and the final reply). Approvals,
questions and errors always show. Consecutive tool calls fold into one summary row such as "Ran 2
commands, edited 3 files".
- t3code: `apps/web/src/components/chat/WorkLog.tsx`, `TimelineWorkGroupRows.tsx`;
  `docs/user/activity-log.md`.
- Dobius+: `ChatPane.jsx` rendering of blocks from `shared/chat-rows.js` (`normalizeBlocks`).
  Desktop and phone share the contract, so one setting serves both. Effort: S to M. Value: high for
  reading long turns on the phone.

**T5. Queue or steer, and edit queued messages.** While a turn runs, the send button shows whether
it will queue or steer; Cmd+Enter does the opposite once; queued messages show as dashed cards that
can be edited (Option+Up edits the last one), sent now, or removed; Cmd+Shift+Enter sends the oldest
queued one as a steer.
- t3code: `QueuedRunsControl.tsx`, `queuedMessageEdit.ts`, `composerShortcuts.ts`;
  `docs/user/composer.md` "Send while the agent is working", "Queued messages". Converges with Orca
  `native-chat/queue/`.
- Dobius+: `ChatPane.jsx` already tags `queued` rows; Claude Code itself queues typed input, so
  steer maps to "send now". Effort: M. Value: medium.

**T6. Prompt stash.** Cmd+S saves the current draft for later; in an empty composer Cmd+S restores
it (or opens a menu when there are several).
- t3code: `ComposerStashMenu.tsx`, `ComposerStashBadge.tsx`; `docs/user/composer.md` "Prompt stash".
- Dobius+: ChatPane already persists drafts (`draftRestorers`); add named stashes. Effort: S.
  Value: medium.

**T7. Cite a reply in the composer.** Select text inside one assistant reply, "Cite in composer"
adds a quote chip with an optional comment; the agent is told which words were quoted.
- t3code: `AssistantSelectionToolbar.tsx`, `AssistantCitationChip.tsx`. Converges with Orca
  `selection-quotes/`.
- Dobius+: `ChatPane.jsx`. Effort: M. Value: medium.

**T8. Timeline minimap.** Thin strips on the right edge, one per message, the in-view band
highlighted, a fisheye on hover; hidden on touch (`@media (pointer:fine)`); animates only
`transform` and `opacity` because it updates on every scroll tick.
- t3code: `TimelineMinimap.tsx`, `timelineMinimapItems.ts`. Converges with Orca
  `NativeChatMessageRail.tsx`.
- Dobius+: `ChatPane.jsx`, `ChatPane.css`. Effort: M. Value: medium.

**T9. Side chat.** `/side` or `/btw` asks a question about the current work without adding it to the
main thread; "Bring back" pastes what you learned into the next message.
- t3code: `SideChatPane.tsx`; `docs/user/thread-sidebar.md` "Side chats".
- Dobius+: open a side tab with `claude --resume <id> --fork-session` from the tab menu in
  `TerminalTabBar.jsx` (the fork never writes into the original transcript). Effort: M. Value: medium.

**T10. One stack for composer banners.** Every notice above the composer (limit, update, resume,
plan follow-up) uses one slot component and one stack that owns priority, collapse and dismiss.
- t3code: `ComposerBanner.tsx`, `ComposerBannerStack.tsx`; `docs/internals/web-ui.md` "Composition".
- Dobius+: `ResumeBanner.jsx`, `UpdateBanner.jsx`, ChatPane notices. Effort: S to M. Value: medium
  (consistency, and the limit banner in T3 needs a home).

### Navigation, focus and keyboard

**T11. Focus goes back where it came from, and F6 cycles areas.** Closing the palette returns focus
to the composer or terminal; F6 and Shift+F6 move between sidebar, content, composer and visible
panels and restore the last focused control in each; number keys pick palette rows while it is open;
typing anywhere sends letters to the composer.
- t3code: `docs/user/keyboard-focus.md`; `composerFocusRedirect.ts`.
- Dobius+: `src/components/shared/CommandPalette.jsx`, key handling in
  `src/components/Project/ProjectView.jsx`. Effort: S to M. Value: medium.

**T12. Keybindings file.** `keybindings.json` of `{key, command, when}` rules; new defaults merge in
without overwriting edits; a bad rule is ignored, an unreadable file falls back to defaults; a
Settings page lists every command id.
- t3code: `packages/shared/src/keybindings.ts`, `keybindingMatching.ts`,
  `apps/web/src/routes/_chat.settings.keybindings.tsx`; `docs/user/keybindings.md`.
- Dobius+: shortcuts are hard-coded in `ProjectView.jsx` and the Electron menu. Would also let us
  fix the reserved-shortcut clashes in section 4 without breaking habits. Effort: M. Value: medium.

**T13. Terminal scrollback keys.** Shift+PageUp/PageDown read scrollback without leaving input;
Cmd+Shift+Home/End jump to start and latest; "Select all retained output" and "Jump to latest" in the
context menu.
- t3code: `docs/user/terminal.md`.
- Dobius+: `src/components/Project/TerminalPane.jsx` (`term.scrollPages`, `scrollToTop`,
  `scrollToBottom`, `selectAll`). Effort: S. Value: medium.

**T14. Settle and snooze.** Move finished work out of the active list without closing it; snooze a
tab until a time or until a limit resets; settle idle work automatically after 7 days. Drag shows the
action ("Pin", "Settle", "Wake") before release.
- t3code: `Sidebar.snooze.ts`, `Sidebar.drag.ts`; `docs/user/thread-sidebar.md`.
- Dobius+: the tab list in `src/components/Project/Sidebar.jsx` and `TerminalTabBar.jsx`. Snoozed
  tabs keep their PTY. Effort: M. Value: medium.

### Feedback, status and notifications

**T15. Notification gate.** One rule decides when to notify: the first sighting of a thread never
notifies, archived and quiet runs never do, a new "needs input" key notifies once, a completion
notifies only if newer than the last handled one, and threads that left the list are forgotten.
- t3code: `apps/web/src/components/ThreadNotificationCoordinator.logic.ts` (47 lines).
- Dobius+: the logic for Orca idea O3 (Dock badge and finished notifications) in `electron/main.js`.
  Effort: S. Value: high when paired with O3.

**T16. One slow-request warning.** A single warning toast appears while any IPC call has waited past
its threshold ("2 requests waiting longer than 5s"), expands to list them with start times, and
closes itself when they finish.
- t3code: `apps/web/src/components/SlowRpcRequestToastCoordinator.tsx`.
- Dobius+: time `ipcRenderer.invoke` in `electron/preload.js`, show in the renderer; main-side stalls
  are already logged by `electron/stall-watchdog.js`. Effort: S to M. Value: medium (turns "the app
  froze" into a named cause).

**T17. Anchored "Copied!" bubble.** Copy success shows a 1,000 ms tooltip-style bubble on the button;
failure shows an error bubble there with the message.
- t3code: `apps/web/src/components/ui/anchoredCopyToast.ts`.
- Dobius+: replaces `window.alert('Copy failed...')` in `TerminalTabBar.jsx:858` and gives the
  Copy button in `CommandsList.jsx` (line 100) a visible success. Effort: S. Value: medium.

**T18. Live elapsed time without re-rendering.** Working turns show "3m 07s" in tabular numerals,
updated by writing the text node from a shared tick, not by React state.
- t3code: `apps/web/src/components/chat/AgentElapsed.tsx`.
- Dobius+: tab hover card (`SessionHoverCard.jsx`) and status bar. Effort: S. Value: low-medium.

**T19. Screen reader announcements.** One polite `aria-live` region per open thread announces
status changes; it avoids `role="status"` because the Orca screen reader (the Linux one, not the
app) maps that role to a status bar in Chromium and drops its updates.
- t3code: `apps/web/src/components/chat/ThreadActivityAnnouncer.tsx`.
- Dobius+: `ProjectView.jsx` for tab status changes. Effort: S. Value: low-medium (accessibility).

### Setup, support, layout

**T20. Welcome wizard.** Connect computers; check each one for Claude Code and Codex, and when one
is missing or signed out open a terminal with the vendor's own install or login command ready;
import projects found in Claude, Codex and Pi history (git repos with activity in the last 30 days
and at least 3 conversations are preselected; Downloads and scratch folders never offered); skippable
at every step; `/welcome` re-runs it; if saved settings cannot be read it says so with Retry and never
replaces them with defaults.
- t3code: `apps/web/src/components/onboarding/WelcomeWizard.tsx`, `FirstRunGate.tsx`,
  `apps/web/src/routes/welcome.tsx`; `docs/user/welcome-wizard.md`. Converges with Orca O1.
- Dobius+: the project-import step maps straight onto data we already read
  (`electron/data-service.js` `loadAllSessions`). New `src/components/Onboarding/`. Effort: L.
  Value: very high for new Macs and the Windows beta.

**T21. "Triage an issue" in the palette.** Opens a fresh agent tab with a playbook, the app version,
where the logs are, and the matching source, so the user's own agent investigates and drafts a
GitHub issue, asking before it fixes or posts anything. `npx t3 triage` does the same from a
terminal when the app will not start.
- t3code: `.github/triage/PLAYBOOK.md`; `docs/user/triage.md`.
- Dobius+: a palette action in `src/lib/command-palette.js` that opens a tab in `~` with a prompt
  naming `<userData>/logs/error.log`, the version, and the reports repo used by
  `electron/error-reporter.js`. Effort: S. Value: medium-high for Brett, Jacob and Max.

**T22. Middle truncation.** Paths and long names cut in the middle on a word boundary
(`dobius-plus/.../TerminalPane.jsx`), by code point so emoji never split, refitted by
ResizeObserver, using clipping so layout never shifts.
- t3code: `apps/web/src/components/ui/middle-truncate.tsx`.
- Dobius+: tab labels (`TerminalTabBar.jsx`), History rows (`Sessions.jsx`), `FilesPanel.jsx`.
  Effort: S. Value: medium.

**T23. Motion as a user setting, default off.** Sidebar, right panel and terminal drawer open
instantly by default; a "Panel animations" slider adds 0 to 400 ms; switching threads snaps to the
new layout without replaying transitions; list reorders use a 150 ms ease-out FLIP.
- t3code: `docs/user/appearance.md` "Motion", `apps/web/src/components/Sidebar.motion.ts`.
- Dobius+: Settings > Appearance plus one `MotionConfig` at the root (`src/App.jsx`); our side panels
  currently spring with visible bounce. Effort: S. Value: medium.

**T24. Turn-scoped diffs.** A turn's changed files show only that turn's own work (files brought in
by a pull or merge are left out); a Commits picker reviews one commit at a time; Cmd+F in a diff
searches every file including folded ones; files can be marked viewed.
- t3code: `ChangedFilesTree.tsx`, `DiffStatLabel.tsx`, `apps/web/src/components/diffs/`
  (built on `@pierre/diffs`); `docs/user/source-control.md`, `docs/user/keybindings.md`.
- Dobius+: `src/components/Dashboard/Git/DiffViewer.jsx`, `GitSidePanel.jsx`. Effort: M to L.
  Value: medium.

### Performance

**T25. Long-lived component hygiene and bounded history.** In big components that live for the
whole session, handlers are plain functions wrapped by `useStableCallback` only where they leave the
component, because memoised closures from different renders keep old renders (and their data) alive.
React Compiler is on with a lint that fails on any file it skips. Chat history loads in bounded
windows (about 1 MiB, 500 rows or 10 user turns) and tool output bodies are not sent to clients until
expanded.
- t3code: `docs/internals/web-ui.md` "Handlers in large components", "React Compiler";
  `docs/internals/performance-regressions.md`; `@legendapp/list` for the timeline.
- Dobius+: `ChatPane.jsx` (1,261 lines), `ProjectView.jsx` (1,618), `TasksDropdown.jsx` (1,325);
  phone chat payloads in `electron/mobile-server.js`. Effort: M. Value: medium-high (memory over
  multi-day uptime).

## Top 10: take these (value over effort)

| # | Idea | Value | Effort | Where in Dobius+ |
|---|---|---|---|---|
| 1 | T1 Hold question cards while typing | High | S-M | `ChatPane.jsx`, phone chat |
| 2 | T15 Notification gate (with Orca O3 Dock badge) | High | S | `electron/main.js` |
| 3 | T2 Up-arrow prompt recall | Medium-high | S | `ChatPane.jsx` |
| 4 | T21 Triage an issue | Medium-high | S | `src/lib/command-palette.js` |
| 5 | T4 Tool-call visibility setting and grouped summaries | High | S-M | `ChatPane.jsx`, `shared/chat-rows.js` |
| 6 | T3 Resume at reset, Snooze until reset | High | M | `ChatPane.jsx`, `TerminalTabBar.jsx`, main scheduler |
| 7 | T13 Terminal scrollback keys | Medium | S | `TerminalPane.jsx` |
| 8 | T17 Anchored Copied bubble | Medium | S | `TerminalTabBar.jsx`, `CommandsList.jsx` |
| 9 | T22 Middle truncation | Medium | S | `TerminalTabBar.jsx`, `Sessions.jsx` |
| 10 | T11 Focus return and F6 areas | Medium | S-M | `CommandPalette.jsx`, `ProjectView.jsx` |

Biggest single item outside the ratio ranking: T20 welcome wizard, which both t3code and Orca built.
Do it once, as one onboarding that takes Orca's step shape and t3code's project import.

## Apple UX rules applied to Dobius+ today

Rules from `~/.claude/skills/apple-ux/SKILL.md`; the same audit with full counts is in
`orca-study.md` section 4. The t3code fixes that answer each one are noted.

1. **Text under 10 px.** 99 inline 8 to 9 px sizes, worst in
   `src/components/Dashboard/Orchestrator/OrchestratorView.jsx`, `Dashboard/Agents.jsx`,
   `shared/TasksDropdown.jsx`, `shared/StatusBar.jsx`. Body runs at 12 px (`text-xs`), not 13.
2. **Blocking OK/Cancel dialogs.** 17 `window.confirm`/`window.alert` calls, including
   `TerminalTabBar.jsx:191` (pinned close, should be undo) and `TerminalTabBar.jsx:835,840,858`
   (information and a copy failure as blocking alerts; T17 is the fix for the copy case).
3. **Springs with bounce on side panels.** `GitSidePanel.jsx:65`, `FilesPanel.jsx:116`,
   `GitTreePanel.jsx:134`, `Git/DiffViewer.jsx:24` overshoot 3.7%. t3code opens panels instantly by
   default (T23).
4. **No root Reduce Motion handling.** Only `ChatPane.jsx`/`.css` check it.
5. **`button { transition: all 150ms ease }`** in `src/styles/index.css:54` delays press feedback.
6. **Hand cursor and selectable chrome.** 159 `cursor-pointer`, 3 `select-none`.
7. **Custom always-on scrollbars** in `src/styles/index.css:35-52` replace macOS overlay scrollbars.
8. **Reserved shortcuts.** Cmd+G opens Git (`ProjectView.jsx:1177`, Mac standard is Find Next),
   Cmd+B toggles the sidebar (`ProjectView.jsx:1170`, Apple uses Ctrl+Cmd+S). A keybindings file
   (T12) lets us move them without trapping old habits.
9. **Inactive windows keep the active look** (`src/lib/window-focus.js` feeds only "seen" logic).
10. **Unnamed icon buttons and no live region.** 297 buttons, 49 `aria-label`s; no `aria-live`
    for status changes (T19).

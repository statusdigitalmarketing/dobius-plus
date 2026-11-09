# Orca study: what Dobius+ should take

Date: 2026-11-09. Source: github.com/stablyai/orca at `c323f876b8` (main, 2026-11-09), read with
`gh api` only (README, docs/, docs/styleguide/, docs/site/content/docs/*.mdx and selected files under
src/). Nothing was cloned, downloaded or run. Licence: MIT, "Copyright (c) 2026 Lovecast Inc.".

Taking an idea needs nothing. Adapting code needs the MIT notice kept: put the Orca copyright and
licence text in a `THIRD_PARTY_NOTICES.md` at the repo root and a one-line `// Adapted from Orca
(MIT), <path>` header on the file. Dobius+ has no notices file yet; the t3code-derived context ring in
`src/components/shared/StatusBar.jsx` only says "same geometry idea", which is fine because no code
was copied.

Already taken from elsewhere and not re-proposed here: the Cmd+P palette (t3code, b832c71) and the
context-window ring.

## 1. What Orca is

Orca is the closest product to Dobius+ that exists: an Electron app (React, TypeScript, Tailwind,
shadcn primitives, Geist font) that runs Claude Code, Codex and about 20 other CLI agents in tabs,
with a structured chat view, a phone app (iOS and Android), usage and account switching, a browser
pane and a CLI. Scale: about 39,000 files, 12,000 of them under `src/renderer/src`. It is
worktree-first (every task gets a git worktree) where Dobius+ is project-window-first.

Map of the parts that matter to us:

| Area | Orca location | Dobius+ equivalent |
|---|---|---|
| Terminal tabs and splits | `src/renderer/src/components/terminal-pane/`, `tab-bar/`, `lib/pane-manager/` | `src/components/Project/TerminalPane.jsx`, `TerminalTabBar.jsx` |
| PTY ownership | `src/main/daemon/` (a separate daemon process owns every PTY) | `electron/terminal-manager.js` (main process owns PTYs) |
| Chat UI | `src/renderer/src/components/native-chat/` (627 files) | `src/components/Project/ChatPane.jsx` + `shared/chat-rows.js` |
| Status bar | `components/status-bar/` (usage roster, account switchers, ports, resources, caffeinate) | `src/components/shared/StatusBar.jsx` |
| Jump palette | `components/worktree-jump/`, `components/cmd-j/` | `src/components/shared/CommandPalette.jsx`, `src/lib/command-palette.js` |
| Onboarding | `components/onboarding/`, `feature-tips/`, `contextual-tours/` | none |
| Activity feed | `components/activity/` | Fleet tab, Tasks dropdown |
| Diff review | `components/diff-comments/`, `right-sidebar/` | `src/components/Dashboard/Git/DiffViewer.jsx`, `shared/GitSidePanel.jsx` |
| Power | `src/main/power/agent-awake-service.ts` | `electron/mobile-server.js` (phone server only) |
| Design rules | `docs/STYLEGUIDE.md`, `docs/styleguide/*.md` | none |

### Chat UI (native chat)

Two kinds of chat: a structured chat that talks to the agent directly, and a transcript view over a
running terminal agent (what Dobius+ Chat is). Either can be continued in the other form ("Continue
in Chat UI", "Continue with Terminal Agent", `Cmd+Shift+J` toggles a terminal-backed one). Pieces
worth knowing, each in its own folder under `native-chat/`:

- `composer/`: model, effort and mode pills read from the installed CLI, slash catalog shared with
  mobile, launch options before the agent starts.
- `drafts/`: unsent text and attachments persist per pane in IndexedDB, survive reconnects; sent
  prompt history with arrow-key recall (`use-native-chat-composer-recall.ts`).
- `queue/`: messages typed while a turn runs are queued as cards you can edit, reorder or remove.
- `prompts/`: AskUserQuestion and approvals render as cards with keyboard answers and a receipt.
- `viewport/`: follow-the-tail scrolling (`native-chat-autoscroll.ts`: jump button hidden within
  48 px of the end, re-arm within 4 px), a message rail of ticks with hover previews
  (`rail/NativeChatMessageRail.tsx`), a find bar, paged older history.
- `tools/`: tool calls grouped into runs with counts, a per-turn diff rollup, opened-PR cards,
  background task list.
- `usage/`: context ring, account usage card, usage-limit actions and auto-continue at reset.
- `selection-quotes/`: select text anywhere, "Add to chat" quotes it into the composer.
- `links/`: hover previews of GitHub and web links.
- Typography is lint-enforced (`docs/styleguide/native-chat.md`): five sizes only (14, 12, 11, 10,
  12 mono), all scaling from one Text size setting.

### Other UI

Jump palette (`Cmd+J`): recent chats and terminals first, ranked needs-you then done then idle,
`Cmd+1..6` jump to them, order frozen while open. Agents feed: one threaded list of completions,
blocks and reply previews across every workspace. Notifications: system ping, sound, header bell,
Dock badge mirrors unread, mark unread. Usage roster in the status bar with every provider, tightest
limit first, warning chip at 80%. Resource manager listing PTYs with memory. Ports segment. Keep
awake while agents work. Quick Commands. Annotate AI Diff. Session History panel. Agent hibernation.
Floating terminal. Dictation. Plugins and themes.

### New-machine setup and onboarding

- First launch (`docs/site/content/docs/install.mdx`): asks for home-folder access, offers to import
  `~/.claude`, `~/.codex` and Ghostty settings, lands on an empty screen whose one action is "Add
  Repo".
- `OnboardingFlow.tsx` runs six short steps: Chat or Terminal, default agent, theme (light/dark tiles
  then a theme gallery with live chrome preview), Windows terminal defaults (Windows only),
  notifications (with "Send test notification" and a macOS permission card that updates from the
  test result), GitHub integration (skipped if `gh` is already installed and signed in).
- Every step can be skipped; "Set up later" asks once (`OnboardingSkipConfirmationDialog.tsx`).
  Cmd+Enter continues. State is `{closedAt, flowVersion, lastCompletedStep}`, and
  `onboarding-flow-state.ts` remaps progress when the flow changes between versions so nobody is
  rewound.
- After onboarding, one-time feature tips (`feature-tips/`: Cmd+J, Chat UI, session search,
  dictation, CLI) and contextual tours (`contextual-tours/`) that never start before the user's last
  finished step.
- `docs/site/content/docs/first-session.mdx` is the whole product in six steps (add repo, worktree,
  agent, race three, watch, ship), which is a model for our own README.

## 2. Ideas worth taking

Effort: S is under a day, M a few days, L a week or more. "Converges" means t3code does the same
thing independently, which is a strong signal (see `t3code-second-pass.md`).

**O1. First-run onboarding.** Six skippable steps with live previews, a test notification and
skip-already-satisfied steps.
- Orca: `src/renderer/src/components/onboarding/` (`OnboardingFlow.tsx`, `AgentStep.tsx`,
  `ThemeStep.tsx`, `NotificationStep.tsx`, `onboarding-flow-state.ts`, `should-show-onboarding.ts`).
- Dobius+: new `src/components/Onboarding/` shown from the Launcher (`src/components/Launcher/ProjectList.jsx`)
  when `config.onboarding.closedAt` is null (`electron/config-manager.js`). Steps that fit us: find
  `claude` and `codex` (same PATH probe style as `electron/gws-setup.js`) with "open a tab with the
  install or login command ready"; New Tab Starts (`settings.newTabTool`); theme with live preview
  (`src/lib/themes.js`); tab status dots hooks (main.js `addDobiusHooks`) plus a test notification;
  pair the phone (QR from the phone server); Google accounts (`GwsSetup.jsx`).
- Value: very high. Every new Mac (Brett, Jacob, Max, the Windows beta) currently starts on a list
  with nothing explaining hooks, phone pairing or accounts. Converges with t3code's welcome wizard.
- Effort: L. Licence: idea only.

**O2. Keep the Mac awake while agents work.** A power assertion held only while any agent is
working, shown as a status bar segment.
- Orca: `src/main/power/agent-awake-service.ts`, `macos-system-sleep-assertion.ts`,
  `components/status-bar/CaffeinateStatusSegment.tsx`.
- Dobius+: `electron/mobile-server.js` already calls `powerSaveBlocker.start('prevent-app-suspension')`
  but only while the phone server runs. Drive it from tab status (`electron/terminal-status.js`: any
  tab working), add a toggle in Settings and a small moon/cup segment in `StatusBar.jsx`.
- Value: high. Overnight grinds stop when the lid timer sleeps the Mac. Effort: S.

**O3. Dock badge and finished notifications.** Unread count on the Dock icon, a system notification
when an agent finishes or needs you while the window is not focused, mark unread.
- Orca: `docs/site/content/docs/notifications.mdx`, `components/activity/useActivityUnreadCount.ts`.
- Dobius+: `app.dock.setBadge(String(n))` in `electron/main.js`, n = red plus unread tabs across
  windows (`electron/terminal-status.js`, `src/lib/tab-unread.js`); notification on a hook `done` or
  `needs` when no Dobius window is focused (`src/lib/window-focus.js` signal already exists). Use the
  t3code notification gate (first sighting never notifies) to avoid a burst on launch.
- Value: high. Effort: S.

**O4. Adopt a written UI style guide and review rubric.** Orca's design rules are short, concrete
and enforced: colour roles in pairs, three elevation levels only, list-row states, copy that never
overclaims, a feedback ladder by duration, a quiet back-out path, a 5-part screen review format.
- Orca: `docs/STYLEGUIDE.md`, `docs/styleguide/ux-rules.md`, `ux-review-rubric.md`, `color.md`,
  `native-chat.md` (lint rules in `config/ast-grep/rules/native-chat-*.yml`).
- Dobius+: new `docs/STYLEGUIDE.md` that points at `~/.claude/skills/apple-ux/SKILL.md` (already
  folds in the ladder and the copy rule) and names our tokens in `src/styles/index.css`. Add a test
  or lint that fails on inline font sizes under 10 px.
- Value: high, stops the drift listed in section 4. Effort: S.

**O5. Usage roster in the status bar.** One click shows every account's windows as bars, tightest
first, with reset times; a chip turns on at 80%; % used or % remaining is a setting; refresh on focus
when older than 5 minutes and every 15 minutes while focused.
- Orca: `components/status-bar/UsageRosterPanel.tsx`, `StatusBarProviderSegment.tsx`,
  `ClaudeSwitcherMenu.tsx`, `CodexSwitcherMenu.tsx`, `StatusBarUsageEmptyCta.tsx`;
  `docs/site/content/docs/agents/usage-tracking.mdx`.
- Dobius+: usage is rendered only inside Settings > Accounts (`src/components/Dashboard/AccountUsage.jsx`
  mounted by `AccountsSection.jsx`); `src/lib/usage-format.js` already colours at 75/90%. Add a
  segment to `StatusBar.jsx` that opens the same data as a popover with "Move tab to..." per row
  (`MoveAccountDialog.jsx`).
- Value: high. Sam hits limits; today seeing which account has room means opening Settings.
  Effort: M.

**O6. Recent tabs across every window, ranked by attention.** With an empty query the palette lists
up to six recent agent tabs from all projects, red first, then green unseen, then idle; `Cmd+1..6`
picks; rows show live status; order freezes while open.
- Orca: `components/worktree-jump/WorktreeJumpPalette.tsx`, `use-worktree-jump-palette-recent-tabs.ts`,
  `components/cmd-j/palette-live-status.tsx`, `palette-session-age.ts`;
  `docs/site/content/docs/model/quick-open.mdx`.
- Dobius+: a "Waiting on you" section at the top of `src/lib/command-palette.js`, fed by a
  main-process list of tabs per window (`electron/window-manager.js`) and their status. Choosing a
  row focuses that window and calls `store.showTab(id)`.
- Value: high with 10+ windows open. Effort: M. Extends our palette; not a re-proposal of it.

**O7. Quick Commands.** Saved commands or prompts, Global or per project, a tab-bar button that runs
one in a fresh tab, a context-menu item that types it into the current tab, a copy button, the same
list on the phone.
- Orca: `components/terminal-quick-commands/` (`TerminalQuickCommandDialog.tsx`, scope field,
  append-Enter switch); `docs/site/content/docs/terminal.mdx#quick-commands`.
- Dobius+: reuse the safe run path built for handed-back commands (`electron/handoff-commands.js`,
  `handoffCommands:prepare` one-time token, run script via `shared/new-tab.js`), so a saved command
  never gets typed into a Claude prompt. UI in `NewTabPicker.jsx` and the tab menu in
  `TerminalTabBar.jsx`; store in `config.settings.quickCommands`.
- Value: high (release, test, deploy, `codex review` prompts). Effort: M.

**O8. Agent hibernation.** Off by default. A finished, hidden, untouched agent tab idle for 30 min
(1 min to 24 h) has its process stopped; showing the tab again runs `claude --resume <id>` or
`codex resume <id>` with the same env. Never while a phone drives it or children still run.
- Orca: `docs/site/content/docs/agents/hibernation.mdx` (the full rule list is the spec).
- Dobius+: `electron/terminal-manager.js` plus `store.resumeSession` (NOTES 2026-09-15: always
  delegate to resumeSession, never reimplement the claim). Session id from
  `tab-context.js resolveSessionForTab`.
- Value: high. NOTES record releases and Codex reviews killed by memory pressure with 18 sessions
  resident. Effort: L.

**O9. Session History detail actions.** Row detail shows the full first prompt with Copy, plus Copy
resume command, Copy session id, Reveal log, Open folder; scope Workspace / Project / All; group by
folder or agent; hide empty sessions; drag a row into the window to resume.
- Orca: `docs/site/content/docs/agents/session-history.mdx`.
- Dobius+: `src/components/Dashboard/Sessions.jsx`, `src/components/Project/SessionHoverCard.jsx`.
- Value: medium. Effort: S.

**O10. Annotate a diff and send one batch.** Hover a diff line, `+` or `c` adds a note, `Cmd+Enter`
saves, "Send to agent" builds one prompt with every note anchored to file and line and lets you pick
which tab gets it. Notes stay to verify the fix.
- Orca: `components/diff-comments/` (`DiffCommentPopover.tsx`, `diff-comment-line-range.ts`);
  `docs/site/content/docs/review/annotate-ai-diff.mdx`.
- Dobius+: `src/components/Dashboard/Git/DiffViewer.jsx`, `src/components/shared/GitSidePanel.jsx`;
  deliver through the same paste-and-submit path as `/openTab` (`electron/bridge-open-tab.js`).
- Value: medium-high. Effort: M to L.

**O11. Chat transcript navigation.** A thin rail of ticks, one per user message, with a hover
preview card, arrow keys inside, one tab stop for the whole rail, dimmed at rest. Plus find in chat.
- Orca: `native-chat/viewport/rail/NativeChatMessageRail.tsx`, `viewport/find/NativeChatFindBar.tsx`.
- Dobius+: `src/components/Project/ChatPane.jsx` and `ChatPane.css`. Converges with t3code's
  `TimelineMinimap.tsx`.
- Value: medium (long sessions). Effort: M.

**O12. Add selection to chat.** Select text in a reply (or a diff, or a file) and choose "Add to
chat"; it lands in the composer as a quote chip.
- Orca: `native-chat/selection-quotes/` (`SelectionAddToChatPopover.tsx`). Converges with t3code
  "Cite in composer" (`AssistantSelectionToolbar.tsx`).
- Dobius+: `ChatPane.jsx` composer. Effort: M. Value: medium.

**O13. Resource and ports segments.** A status bar popover listing each running agent process with
memory, a kill button, and the local ports its tab started with Open and Stop.
- Orca: `components/status-bar/ResourceUsageStatusSegment.tsx`, `ResourcePtyPanel.tsx`,
  `PortsStatusSegment.tsx`. Converges with t3code `ThreadServersPanel.tsx`.
- Dobius+: `electron/claude-process-scan.js` already reads ps read-only; add RSS and `lsof -iTCP
  -sTCP:LISTEN` for each tab's descendant PIDs; show in `StatusBar.jsx`; Open uses `BrowserPane.jsx`.
- Value: medium-high (finding the stray dev server, seeing which session eats 3 GB). Effort: M.

**O14. Terminal link popover and Copy Context.** A plain click on a terminal link opens a small menu
(Open in Dobius browser, Open in system browser, Copy link); Cmd-click still opens directly. Right
click, "Copy Context" copies a bounded recent transcript.
- Orca: `docs/site/content/docs/terminal.mdx` (Link actions, Copy terminal context).
- Dobius+: the web-links addon handler in `src/components/Project/TerminalPane.jsx`. Effort: S.
  Value: medium.

**O15. Hook endpoint read at call time.** Orca writes the hook endpoint to
`{userData}/agent-hooks/endpoint.env` and the hook re-reads it on every call, so sessions that
outlive an app restart still reach the new app.
- Dobius+: check `<userData>/bin/dobius-codex-status` and the Claude status hook in the managed block
  for any port or token baked in at install time. If baked, read it per call. Effort: S. Value:
  medium (status dots going quiet after an update, if it happens).

**O16. Typing latency probe.** Keystroke-to-echo latency and renderer long tasks sampled into a
diagnostic report.
- Orca: `src/renderer/src/lib/typing-latency/` (`echo-instrumentation.ts`, `renderer-long-tasks.ts`).
- Dobius+: a `PerformanceObserver({type:'longtask'})` in the renderer writing to the same log as
  `electron/stall-watchdog.js`; echo timing in `TerminalPane.jsx`. Effort: M. Value: medium.

**O17. Design mode in the browser pane.** Click any element in the embedded browser to copy its
HTML, computed styles and selector, then paste into the agent's prompt.
- Orca: `docs/site/content/docs/browser/design-mode.mdx`, `components/browser-pane/`.
- Dobius+: `src/components/Project/BrowserPane.jsx` (webview preload). Effort: M. Value: medium for
  web projects (Pocket, Better Health).

**O18. PTYs owned by a daemon (strategic).** A separate daemon owns every PTY, so Cmd+Q, an
auto-update relaunch or an app crash leaves agents running and the next launch reattaches with the
scrollback produced meanwhile. "Quit Completely" is the explicit way to stop everything.
- Orca: `src/main/daemon/` (read `AGENTS.md` there first: its socket-ownership protocol took seven
  review rounds and lists the traps), `docs/site/content/docs/model/session-restore.mdx`.
- Dobius+: would move PTY ownership out of `electron/terminal-manager.js`. It directly serves Sam's
  rule that the update path never loses windows, and would remove the resume dance after updates.
- Value: very high. Effort: XL. Not in the top 10 on value over effort; worth a design doc and a
  Codex design review before any code.

Not proposed: worktree-per-task (different product model), plugins, floating terminal, the pet,
Linear/Jira integrations, Codex hot swap (we already have per-tab "Continue on switched account").

## 3. Top 10: take these (value over effort)

| # | Idea | Value | Effort | Where in Dobius+ |
|---|---|---|---|---|
| 1 | O2 Keep awake while agents work | High | S | `electron/mobile-server.js` power code moved to tab status, `StatusBar.jsx` |
| 2 | O3 Dock badge and finished notifications | High | S | `electron/main.js`, `terminal-status.js` |
| 3 | O4 Style guide and rubric (and the 10 px floor) | High | S | `docs/STYLEGUIDE.md`, `src/styles/index.css` |
| 4 | O5 Usage roster in the status bar, 80% chip | High | M | `StatusBar.jsx`, data from `AccountUsage.jsx` |
| 5 | O6 Recent tabs across windows, needs-you first | High | M | `src/lib/command-palette.js`, `window-manager.js` |
| 6 | O7 Quick Commands on the safe run path | High | M | `handoff-commands.js`, `NewTabPicker.jsx` |
| 7 | O9 Session History detail actions | Medium | S | `Sessions.jsx`, `SessionHoverCard.jsx` |
| 8 | O14 Terminal link popover, Copy Context | Medium | S | `TerminalPane.jsx` |
| 9 | O1 First-run onboarding | Very high | L | new `src/components/Onboarding/` |
| 10 | O8 Agent hibernation (off by default) | High | L | `terminal-manager.js`, `store.resumeSession` |

Next after these: O13 resources and ports, O10 annotate diff, O11 transcript rail, O18 daemon
design doc.

## 4. Apple UX rules applied to Dobius+ today

Rules from `~/.claude/skills/apple-ux/SKILL.md`. Counts are from `src/` on branch `int/2-2-14`.

1. **Text below the macOS minimum.** HIG sets 10 pt as the macOS floor and 13 pt as body. Dobius+
   has 99 inline font sizes of 8 or 9 px and 134 at 10 px; reading text is mostly Tailwind
   `text-xs` (12 px, 462 uses) against `text-sm` (49 uses). Worst files:
   `src/components/Dashboard/Orchestrator/OrchestratorView.jsx` (17 sites at 8 to 9 px),
   `src/components/Dashboard/Agents.jsx` (14), `src/components/shared/TasksDropdown.jsx` (13),
   `src/components/Dashboard/Board/BoardView.jsx` (6), `src/components/shared/StatusBar.jsx` (5),
   `src/components/Project/Sidebar.jsx` (5). Fix: type tokens from skill section 1, floor 10 px.
2. **OK/Cancel dialogs instead of undo or verb buttons.** 17 `window.confirm`/`window.alert` calls:
   `src/components/Project/ProjectView.jsx:998,1011` and `TerminalTabBar.jsx:191` (close a pinned
   tab: should just close and offer Undo, since Cmd+Shift+T already reopens),
   `TerminalTabBar.jsx:835,840,858` (pure information shown as a blocking alert),
   `src/store/store.js:827,913,943,990`, `src/components/Dashboard/Settings.jsx:101,134`,
   `AccountUsage.jsx:64`, `AccountsSection.jsx:463`, `Agents.jsx:127`,
   `Orchestrator/OrchestratorView.jsx:471`. Fix: undo toast for reversible actions, in-app sheet
   with verb buttons ("Restart 3 Tabs") for the rest.
3. **Bouncy side panels.** `GitSidePanel.jsx:65`, `Project/FilesPanel.jsx:116`,
   `Project/GitTreePanel.jsx:134`, `Dashboard/Git/DiffViewer.jsx:24` use
   `{stiffness:300, damping:25}`: 0.36 s with bounce 0.28, a 3.7% overshoot. Apple's system UI uses
   bounce 0 to 0.15. Fix: the `panel` spring (438.6 / 41.9).
4. **No Reduce Motion outside Chat.** Only `ChatPane.jsx`/`ChatPane.css` check it. Fix: one
   `<MotionConfig reducedMotion="user">` in `src/App.jsx` and the CSS block from skill section 8.
5. **`transition: all` on every button.** `src/styles/index.css:54` animates layout and colour on
   every state change, so presses feel late. Fix: transition only `background-color, color,
   opacity` at 120 ms, none on `:active`.
6. **Web tells: hand cursor and selectable chrome.** 159 `cursor-pointer` uses (macOS controls keep
   the arrow) and only 3 `select-none`, so tab labels, the top bar and the status bar select on drag.
   Fix: `cursor: default` on controls, `user-select: none` on chrome containers.
7. **Always-on custom scrollbars.** `src/styles/index.css:35-52` styles `::-webkit-scrollbar`,
   which replaces macOS overlay scrollbars and ignores the "Show scroll bars" setting. Fix: drop it,
   or scope it to Windows.
8. **Reserved shortcuts taken.** `Cmd+G` opens Git (`ProjectView.jsx:1177`) where every Mac app
   means Find Next, and Dobius+ has Cmd+F search, so the collision is real. `Cmd+B` toggles the
   sidebar (`ProjectView.jsx:1170`) where Apple uses Ctrl+Cmd+S. `Cmd+Shift+T` means two things by
   view. Fix: Cmd+G and Cmd+Shift+G for next and previous match, sidebar on Ctrl+Cmd+S (keep Cmd+B as
   an alias), Git on Ctrl+Cmd+G or the palette.
9. **Inactive windows look active.** `src/lib/window-focus.js` tracks native focus but only feeds
   "seen" logic; active tab and selected rows keep the accent when the window is in the background.
   Fix: a `window-inactive` class on `<html>` and the gray selection rule from skill section 4.
10. **Unnamed icon buttons.** 297 `<button>` elements, 49 `aria-label`s. Fix: label every icon-only
    button and give it a tooltip.

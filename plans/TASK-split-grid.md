# TASK: Split View → Unified Terminal Grid

**Branch:** `feature/split-grid-terminal` (off `feature/visual-webroot-autodetect` @ 22e62ad — the tip carries the monitors / Cmd+R / split-tab code this work depends on; `main` is 11 commits behind and would lose those).

**Owner:** Carson (build lane)
**Build baseline:** `npm run build` exits 0 (verified before starting).

---

## What

Turn the current fixed two-pane split into a **drag-to-place terminal grid** of up to six cells, while keeping a quick "split in two" entry point. You build the grid by dragging tabs from the tab bar into specific cells (top-left, bottom-left, etc.); each dropped terminal keeps running in place. Empty cells stay empty and hold their position — what you drop bottom-left stays bottom-left.

## Why

- The user wants to watch/drive up to six Claude sessions at once, arranged by hand.
- The existing split view is a separate, fixed code path that (see Risk R1) likely **kills the PTY** when you split, because the pane is unmounted from one container and remounted in another. The grid would hit the same bug six times over.
- One layout engine (split = a 2-cell preset of the same grid) removes the duplicate code path **and** the bug class permanently.

## Design principles (the load-bearing decisions)

1. **Never reparent a live pane.** All `<TerminalPane>`s mount **once** in a single stable list and are positioned into cells by **CSS only**. React changes styles, never unmounts — so xterm + node-pty survive every layout change. This is the same pattern VS Code / video-grid apps use for stateful children. It also satisfies the CLAUDE.md "all tabs stay mounted" rule by construction.
2. **One layout model, two entry points.** Store holds a single `terminalLayout`. "Split" is the preset that fills 2 cells; the grid is the same engine with up to 6. UX keeps them feeling distinct (a split toggle vs. drag-to-build), implementation does not duplicate.
3. **Fixed positions, no auto-collapse.** Empty cells render as faint "drop here" zones and keep their slot. Honors the user's positional mental model.
4. **Active tab stays the single focus/keyboard target.** Each `TerminalPane` already owns its own command bar + xterm input routing, so a 6-grid needs no new focus plumbing. Clicking a cell sets it active.
5. **Equal-sized cells for v1.** Resizable dividers are a fast-follow (they're nearly free given the existing `ResizeObserver`→`fit()`, but not v1).

---

## Phases

### Phase 0 — Verify the bug, then unify the mount model (prerequisite)
- **0a. Prove R1.** Run app, start `sleep 999` in a tab, toggle split, watch whether the process restarts (PID / process badge). Record the result. The refactor's justification stands or falls here.
- **0b.** Refactor `ProjectView` so all panes render in ONE stable keyed list inside a single layout container; visibility/position driven by CSS from layout state. Re-express the **existing** split view on top of this (no separate subtree).
- **Verify:** a running `claude`/`sleep` survives a split toggle (no restart, no fresh shell, scrollback intact). `npm run build` exits 0.
- **Ship as its own commit** — it's an independent bug fix + refactor and leaves the app fully working.

### Phase 1 — Grid state + render
- Store: add `terminalLayout = { mode: 'single' | 'split' | 'grid', slots: [tabId|null × up to 6] }`. Migrate `splitTabId` usage into it. Mutually exclusive modes.
- Cleanup: `removeTab` / `closeOtherTabs` / `closeTabsToRight` null out closed tabs from `slots` (mirror existing `splitTabId` cleanup at store.js:83).
- Render: `TerminalGrid` maps `slots` → CSS grid (2/4/6 cells → 2×1, 2×2, 2×3 templates), positioning the already-mounted panes. Empty slots = faint drop placeholders. Active cell gets a subtle border.
- **Verify:** build 0; six panes can be shown via temporary hardcoded slots; no remounts (instrument a mount log).

### Phase 2 — Drag to place
- Reuse the HTML5 drag already in `TerminalTabBar` (handleDragStart at :165). When NOT in grid mode and a tab-drag enters the terminal area, reveal a 6-slot drop overlay. Dropping assigns that tab to the chosen slot and switches mode to grid.
- Drop more tabs → fill more slots. Drag one cell onto another → swap.
- **Verify:** drag tab into top-left and bottom-left; both run; a `claude` session dragged in keeps running (no restart).

### Phase 3 — Exit + persistence + polish
- "Exit grid" control + `Esc` → back to single (panes stay mounted, just re-hidden).
- Click a cell → set active tab; command bar + Cmd+K + resume follow it.
- Persist `terminalLayout` per project via the existing `terminalSaveTabs` path; load on mount; **skip for tear-off windows** (matches ProjectView:166).
- **Verify:** layout survives reload; tear-off windows unaffected.

### Phase 4 — Gate (house Done Bar, local-first)
- `npm run build` exits 0.
- Re-read every changed file; write `plans/TASK-split-grid-REVIEW.md`.
- `code-reviewer` subagent (Opus); apply valid findings.
- Verify in a **project window** (not launcher): drag a live `claude` session into the grid and back; confirm it never restarts; screenshot.
- Do NOT push/deploy/merge — surface for the user.

---

## Files in scope (terminal view only)
- `src/store/store.js` — layout state + cleanup.
- `src/components/Project/ProjectView.jsx` — unified mount + layout container.
- `src/components/Project/TerminalGrid.jsx` — NEW: grid + drop zones.
- `src/components/Project/TerminalTabBar.jsx` — drag source / split toggle into layout model.
- `src/hooks/useTerminal.js` — only if Phase 0a shows a mount-safety gap; otherwise untouched.
- `electron/*` — only the existing `terminalSaveTabs` config shape (additive key). No new IPC expected.

## Risks
- **R1 (load-bearing):** split currently kills the PTY via unmount→`terminalKill` (useTerminal.js:204). Verified in 0a before building. If false, Phase 0b shrinks.
- **R2:** six simultaneous xterm `fit()`/render loops — perf. Mitigation: the Phase 1 hardcoded-six spike checks this before the drag UX is built.
- **R3:** fitting a pane while `display:none` yields 0 cols. Mitigation: the existing `ResizeObserver` refits on the none→visible transition; add a guard-fit on cell activation if needed.
- **R4:** layout persistence referencing a tab that no longer exists on reload. Mitigation: validate slot tabIds against live tabs on load; drop stale ones.

## Out of scope (explicit)
Resizable dividers (fast-follow), saved layout presets, cross-window grid, anything outside the terminal view.

## Estimate
Phase 0: 0.5d · Phase 1: 0.5d · Phase 2: 0.75d · Phase 3: 0.5d · Phase 4: 0.25d. ~2.5 days.

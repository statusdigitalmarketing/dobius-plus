/**
 * Status color + label constants used by the cross-session status dots —
 * tab status (TerminalTabBar), grid pane status (ProjectView), and session
 * dashboard (Sessions). One source of truth so the three places can't drift.
 *
 * NOTE: these intentionally differ from Mission Control / Board View, where
 * green = working (an agent is actively running). In the monitoring suite,
 * green = done (Claude finished its turn cleanly) — matching the at-a-glance
 * traffic-light semantics most users expect.
 *
 * Hex values mirror the theme's accent/success/danger tokens.
 */
export const STATUS_COLORS = Object.freeze({
  working: '#D29922', // yellow — Claude is actively streaming
  done: '#3FB950',    // green  — Claude finished its turn
  needs: '#F85149',   // red    — user needs to respond
});

export const STATUS_LABELS = Object.freeze({
  working: 'Working',
  done: 'Done',
  needs: 'Needs your response',
});

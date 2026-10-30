// The right-hand status on a Tabs-sidebar row (Brett, Asana 1220055135705774):
// Working (spinner + how long), Input, Waiting (turn over, background work
// still running), Done (finished and not looked at, with how long it worked),
// otherwise nothing and the row shows its plain age.
// Pure so it is tested under plain node (electron/__tests__/tab-activity.test.mjs).

// Plain output (no hook) has to keep flowing this long to count as Working, so
// typing at Claude's prompt or a one-line `ls` never flashes a spinner.
export const WORKING_MIN_MS = 3000;

/** 42s, 4m, 1h 5m, 2h, 3d. Empty for anything that is not a duration. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * @param {object} x
 * @param {boolean} x.live        a PTY runs for this tab right now
 * @param {string}  [x.status]    hook/output status: working | needs | done | idle | queued
 * @param {boolean} [x.hookOwned] the status came from the Claude hook
 * @param {number|null} [x.since] start of the current working stretch (main)
 * @param {number}  [x.lastTurnMs] length of the last turn the hook finished
 * @param {'shells'|'agents'|null} [x.background] proven background work (main)
 * @param {boolean} [x.unread]    a turn finished there and the tab was not viewed since
 * @param {boolean} [x.uncertain] main could not confirm the hook state against a process
 * @param {number}  x.now
 * @returns {{kind:'working'|'input'|'waiting'|'done', text:string, title:string}|null}
 *   null = show the plain age.
 */
export function tabActivityLabel(x) {
  if (!x || !x.live) return null; // a closed tab has no live state to report
  // main could not tell what the tab is doing (a hook turn with no claude it
  // can see): the plain age, never a guess.
  if (x.uncertain) return null;
  const now = x.now;
  if (x.status === 'needs') {
    return { kind: 'input', text: 'Input', title: 'Needs your input (a permission prompt or a question)' };
  }
  if (x.status === 'working') {
    const elapsed = Number.isFinite(x.since) && x.since > 0 && x.since <= now ? now - x.since : null;
    if (x.hookOwned || (elapsed !== null && elapsed >= WORKING_MIN_MS)) {
      const d = elapsed !== null ? formatDuration(elapsed) : '';
      return {
        kind: 'working',
        text: d ? `Working ${d}` : 'Working',
        title: d ? `Working for ${d}` : 'Working',
      };
    }
  }
  // Reached only when not Working: brief keystroke output at the prompt keeps
  // the Waiting it would otherwise flicker away from.
  if (x.background === 'shells' || x.background === 'agents') {
    return {
      kind: 'waiting',
      text: 'Waiting',
      title: x.background === 'shells'
        ? 'Turn finished, a background shell it started is still running'
        : 'Turn finished, a background agent it started is still running',
    };
  }
  if (x.unread) {
    const d = x.lastTurnMs > 0 ? formatDuration(x.lastTurnMs) : '';
    return {
      kind: 'done',
      text: d ? `Done ${d}` : 'Done',
      title: d ? `Finished after ${d} of work, not viewed yet` : 'Finished, not viewed yet',
    };
  }
  return null;
}

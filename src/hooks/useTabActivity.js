import { useEffect, useRef } from 'react';
import { useStore } from '../store/store';

const QUIET_MS = 1500;   // output silence before a working tab settles to "done"
const TICK_MS = 1000;    // how often the settle check runs

/**
 * Per-terminal-tab status from output flow — the secondary layer behind the
 * deterministic Claude hook markers (see useTerminal's OSC 777 handler).
 *
 * - Output flowing  → 'working' (yellow)
 * - ~1.5s of quiet  → 'idle' (gray)
 *
 * It deliberately NEVER sets or clears 'needs' (red): that state is owned by the
 * managed Claude hook so a repainting permission dialog can't flip it, and it
 * persists until the user actually answers (which fires a working/done marker).
 * This layer gives plain shell commands (e.g. a build) a yellow→gray dot. Green
 * ('done') is reserved for a managed Claude/Codex turn finishing (set by the OSC
 * hook in useTerminal), never a plain shell, per Brett's tab-status spec.
 *
 * Call once at the ProjectView level — a single onTerminalData listener routes
 * data to per-tab timers, mirroring useAgentActivity.
 */
export function useTabActivity() {
  const lastDataTs = useRef({});
  const tickTimer = useRef(null);

  useEffect(() => {
    if (!window.electronAPI?.onTerminalData) return;

    const removeDataListener = window.electronAPI.onTerminalData((termId) => {
      lastDataTs.current[termId] = Date.now();
      const { tabStatus, recentHookDone, setTabStatus } = useStore.getState();
      const st = tabStatus[termId];
      // 'needs' (red) is hook-owned and must survive dialog repaints.
      if (st === 'needs') return;
      // Don't clobber a managed turn's green 'done' back to yellow: the marker's
      // own trailing bytes and later repaints (a resize) also arrive here. It
      // holds until Enter is typed in the tab (main sends 'release').
      if (st === 'done' && recentHookDone[termId]) return;
      // Output flowing → working (yellow).
      setTabStatus(termId, 'working');
    });

    tickTimer.current = setInterval(() => {
      const now = Date.now();
      const { tabStatus, setTabStatus, hookOwnedTabs } = useStore.getState();
      for (const [termId, ts] of Object.entries(lastDataTs.current)) {
        // Drop timers for tabs that have been closed (status entry pruned).
        if (!(termId in tabStatus)) { delete lastDataTs.current[termId]; continue; }
        // Only settle 'working' tabs that AREN'T hook-owned. A quiet tool
        // call (long shell exec, slow git fetch) emits no output for many
        // seconds — but the hook's Stop event hasn't fired, so the tab is
        // genuinely still working. hookOwnedTabs is set by useTerminal's OSC
        // handler whenever the marker sets 'working' / 'needs', released
        // when it sets 'done'.
        if (tabStatus[termId] === 'working'
            && !hookOwnedTabs[termId]
            && now - ts > QUIET_MS) {
          // Plain shell settles to gray (idle), NOT green. Green is only for a
          // managed Claude/Codex 'done' marker (hook-owned). Brett's spec.
          setTabStatus(termId, 'idle');
        }
      }
    }, TICK_MS);

    return () => {
      removeDataListener();
      clearInterval(tickTimer.current);
      lastDataTs.current = {};
    };
  }, []);
}

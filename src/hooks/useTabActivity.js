import { useEffect, useRef } from 'react';
import { useStore } from '../store/store';

const QUIET_MS = 1500;   // output silence before a working tab settles to "done"
const TICK_MS = 1000;    // how often the settle check runs

/**
 * Per-terminal-tab status from output flow — the secondary layer behind the
 * deterministic Claude hook markers (see useTerminal's OSC 777 handler).
 *
 * - Output flowing  → 'working' (yellow)
 * - ~1.5s of quiet  → 'done' (green)
 *
 * It deliberately NEVER sets or clears 'needs' (red): that state is owned by the
 * managed Claude hook so a repainting permission dialog can't flip it, and it
 * persists until the user actually answers (which fires a working/done marker).
 * This layer also gives plain shell commands (e.g. a build) a yellow→green dot.
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
      // Output is flowing → working, unless the hook has flagged this tab as
      // needing a response (red is hook-owned and must survive dialog repaints).
      if (useStore.getState().tabStatus[termId] !== 'needs') {
        useStore.getState().setTabStatus(termId, 'working');
      }
    });

    tickTimer.current = setInterval(() => {
      const now = Date.now();
      const { tabStatus, setTabStatus } = useStore.getState();
      for (const [termId, ts] of Object.entries(lastDataTs.current)) {
        // Drop timers for tabs that have been closed (status entry pruned).
        if (!(termId in tabStatus)) { delete lastDataTs.current[termId]; continue; }
        if (tabStatus[termId] === 'working' && now - ts > QUIET_MS) {
          setTabStatus(termId, 'done');
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

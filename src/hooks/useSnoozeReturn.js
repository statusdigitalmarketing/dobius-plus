import { useEffect } from 'react';
import { useStore } from '../store/store';

// A project window takes back its snoozed tabs whose time has come (electron/tab-snooze.js marks them ready). Looked
// at when the window's tabs are ready and whenever main says the list changed; one look at a time, and a change during
// a look runs one more. main's take() hands each entry out once, so two windows of the project cannot both get it.
// Tear-off windows (one torn tab) leave it to a primary window.
export function useSnoozeReturn(projectPath, isTearOff) {
  const tabsReady = useStore((s) => s.tabsReady);
  useEffect(() => {
    const api = window.electronAPI;
    if (!projectPath || isTearOff || !tabsReady || !api?.snoozeList) return undefined;
    let alive = true;
    let running = false;
    let again = false;
    const look = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const list = await api.snoozeList();
          for (const e of Array.isArray(list) ? list : []) {
            if (!alive) return;
            if (!e?.ready || e.projectPath !== projectPath) continue;
            const got = await api.snoozeTake(e.id, { onlyReady: true });
            // Taken means it left the list: restore it even if this effect is going away, or it would be lost.
            if (got?.entry) useStore.getState().restoreSnoozedTab(got);
          }
        } while (again && alive);
      } catch (err) {
        console.warn('[snooze] return failed:', err?.message || err);
      } finally {
        running = false;
      }
    };
    look();
    const off = api.onSnoozeChanged?.(look);
    return () => { alive = false; off?.(); };
  }, [projectPath, isTearOff, tabsReady]);
}

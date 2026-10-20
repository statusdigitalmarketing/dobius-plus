// "Unread" tabs: Claude finished a turn in a tab you were not looking at.
// The tab keeps a marker until it is actually on screen in a focused window.
// Pure so it is tested under plain node (electron/__tests__/tab-unread.test.mjs).

/**
 * Tab ids currently visible in the terminal area. Mirrors ProjectView's
 * paneStyleFor: grid shows its cells; split shows the split pane plus the
 * primary pane (the active tab, or the first other tab when the active tab IS
 * the split pane); otherwise only the active tab. Nothing in the Dashboard.
 */
export function onScreenTabIds({ activeView, activeTabId, splitTabId, gridSlots, terminalTabs }) {
  const ids = new Set();
  if (activeView !== 'terminal') return ids;
  if (Array.isArray(gridSlots) && gridSlots.length) {
    for (const id of gridSlots) ids.add(id);
    return ids;
  }
  if (splitTabId) {
    ids.add(splitTabId);
    const primary = activeTabId === splitTabId
      ? (terminalTabs || []).find((t) => t.id !== splitTabId)?.id
      : activeTabId;
    if (primary) ids.add(primary);
    return ids;
  }
  if (activeTabId) ids.add(activeTabId);
  return ids;
}

/**
 * A finished turn the user did not see happen, decided by the Claude hook
 * alone, never by the displayed status:
 * - the 'done' comes from the hook marker itself (`fromHook`), not from
 *   auto-resume's status channel, which also broadcasts 'done' for a session
 *   it skips while that session is still mid-turn;
 * - the hook still owns the tab (`hookOwned`: its last marker was 'working',
 *   or 'needs' when Stop follows an approved tool directly). The hook's own
 *   'done' releases ownership, so Claude's idle-prompt re-send of 'done' does
 *   not count again.
 * Independent of the previous DISPLAY status on purpose: output flow and
 * auto-resume also write it, and an auto-resume 'done' landing a moment
 * before the hook's own used to swallow the real completion.
 * Known gap: a tab torn off mid-turn starts its new window without hook
 * ownership, so that one completion gets no marker (missing, never wrong).
 */
export function becomesUnread(nextStatus, seen, hookOwned, fromHook) {
  return nextStatus === 'done' && !seen && !!hookOwned && !!fromHook;
}

/** unread map minus every id that is now seen; same object when nothing changes. */
export function clearSeen(unread, seenIds) {
  let next = null;
  for (const id of Object.keys(unread || {})) {
    if (!seenIds.has(id)) continue;
    if (!next) next = { ...unread };
    delete next[id];
  }
  return next || unread;
}

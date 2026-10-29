// Scrollback handed to a tab that is about to mount (a checkpoint fork).
// The forking click sets it right after addTab; the new terminal takes it on
// mount, which React always does after that click handler returns. Waiting on
// the disk save instead raced the mount, so a fork could open empty (Codex).
const pending = new Map();

export function setPendingScrollback(tabId, state) {
  pending.set(tabId, state);
}

export function takePendingScrollback(tabId) {
  const state = pending.get(tabId);
  pending.delete(tabId);
  return state;
}

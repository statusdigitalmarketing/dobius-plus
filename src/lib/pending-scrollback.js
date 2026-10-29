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

// One saved scrollback line made safe to DRAW: every C0 and C1 control is
// removed, not only ESC. A lone C1 byte such as U+009B (CSI) still drives
// xterm, so a saved line could clear the screen or ask for a cursor report
// whose reply goes out as PTY input (Codex P1). Tabs become spaces.
export function drawableLine(line) {
  return String(line).replace(/\t/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// Bytes the terminal emulator sends on its own, not a person typing: focus
// in/out, cursor position and device attribute reports, DECRQM and OSC
// answers. terminal-manager does not count them as input, so a click that
// moves focus cannot mark the prompt on screen stale (Chat selector tokens).
const TERMINAL_REPLY_RE = /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalReply(data) {
  return typeof data === 'string' && TERMINAL_REPLY_RE.test(data);
}

// Escape sequences that draw nothing by themselves: CSI (cursor moves, erase,
// modes), OSC (titles, status markers) and two-byte ESC commands.
const NONVISUAL_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x1f\x7f]/g;

/**
 * Does this output chunk put any character on screen? A status marker or a
 * bare cursor move does not, so it must not count as the prompt having been
 * redrawn after an input (it would make an answered prompt look current).
 */
export function hasVisibleOutput(data) {
  if (typeof data !== 'string' || !data) return false;
  if (!data.includes('\x1b')) return /[^\x00-\x1f\x7f]/.test(data);
  return data.replace(NONVISUAL_RE, '').length > 0;
}

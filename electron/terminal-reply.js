// Bytes the terminal emulator sends on its own, not a person typing: focus
// in/out, cursor position and device attribute reports, DECRQM and OSC
// answers. terminal-manager does not count them as input, so a click that
// moves focus cannot mark the prompt on screen stale (Chat selector tokens).
const TERMINAL_REPLY_RE = /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalReply(data) {
  return typeof data === 'string' && TERMINAL_REPLY_RE.test(data);
}

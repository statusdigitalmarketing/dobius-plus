// Bytes the terminal emulator sends on its own, not a person typing: focus
// in/out, cursor position and device attribute reports, DECRQM and OSC
// answers. terminal-manager does not count them as input, so a click that
// moves focus cannot mark the prompt on screen stale (Chat selector tokens).
// A cursor report `ESC[1;<2-16>R` is left out on purpose: it is byte for byte
// a modified F3 (Shift/Ctrl/Alt+F3), and a key must never pass as a reply.
// ponytail: the cost is that a real cursor report on row 1 counts as input,
// which only makes the selector card re-read once. Tracking outstanding DSR
// queries would remove it.
const TERMINAL_REPLY_RE = /^(?:\x1b\[[IO]|\x1b\[\?\d+;\d+R|\x1b\[(?!1;(?:[2-9]|1[0-6])R)\d+;\d+R|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/;

export function isTerminalReply(data) {
  return typeof data === 'string' && TERMINAL_REPLY_RE.test(data);
}

/**
 * Per-terminal scanner: does this output chunk put any character on screen?
 * A status marker or a bare cursor move does not, so it must not count as the
 * prompt having been redrawn after an input. The state carries across chunks
 * because the PTY splits output anywhere, including inside an OSC string: a
 * stateless check read the tail of `ESC]777;dobius;` + `working BEL` as text.
 * @returns {(data: string) => boolean}
 */
export function createVisibleOutputScanner() {
  // ground | esc (after ESC) | csi | str (OSC/DCS/APC/PM/SOS body) | strEsc (ESC inside str)
  let state = 'ground';
  let belEnds = false; // BEL terminates an OSC only; DCS/APC/PM/SOS end on ST alone
  return (data) => {
    if (typeof data !== 'string' || !data) return false;
    let visible = false;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      switch (state) {
        case 'ground':
          if (c === 0x1b) state = 'esc';
          else if (c === 0x9b) state = 'csi';
          else if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) { state = 'str'; belEnds = c === 0x9d; }
          else if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) visible = true;
          break;
        case 'esc':
          if (c === 0x5b) state = 'csi'; // [
          else if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) { state = 'str'; belEnds = c === 0x5d; } // ] P X ^ _
          else if (c === 0x1b) state = 'esc';
          else if (c >= 0x20 && c <= 0x2f) state = 'esc'; // intermediate, e.g. ESC ( B
          else state = 'ground'; // final byte (or a control that cancels)
          break;
        case 'csi':
          if (c === 0x1b) state = 'esc';
          else if (c >= 0x40 && c <= 0x7e) state = 'ground';
          else if (c === 0x18 || c === 0x1a) state = 'ground'; // CAN / SUB abort
          break;
        case 'str':
          if (c === 0x9c || (c === 0x07 && belEnds)) state = 'ground';
          else if (c === 0x1b) state = 'strEsc';
          else if (c === 0x18 || c === 0x1a) state = 'ground';
          break;
        case 'strEsc':
          // ESC \ ends the string; any other ESC sequence aborts it and starts anew.
          if (c === 0x5c) state = 'ground';
          else { state = 'esc'; i -= 1; }
          break;
      }
    }
    return visible;
  };
}

/** One-shot form of the scanner, for a chunk known to be complete. */
export function hasVisibleOutput(data) {
  return createVisibleOutputScanner()(data);
}

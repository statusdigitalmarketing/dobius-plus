// Does a chunk of PTY output change what is on screen? Sam, 2026-11-05: with a question card up
// and a second one queued behind it, the queued call's status hooks print "working" then "needs"
// markers (OSC 777;dobius;...) into the tab, and the phone refused every tap as "The prompt
// changed" while the first question sat there unchanged. Those markers, and window titles, never
// draw a cell, so a chunk made only of them no longer moves the selector token's output count.
//
// Everything else counts, and so does anything uncertain. The terminal's own parser state is
// followed across chunks (ground, escape, CSI, a control string, ESC inside a string), because a
// string or sequence opened in one chunk can take effect inside the next (Codex, four rounds:
// C1 terminators, palette OSCs, a split ESC \, a C1 OSC opened earlier). A chunk is let through
// only when it starts in ground state, holds nothing but complete-or-continuing title and status
// OSCs introduced by ESC ], and never touches anything else.

// Window and icon titles (0, 1, 2) and Dobius's own tab-status markers.
const INERT = /^(?:[012];|777;dobius;)/;
// Longer than any title or marker we expect: past this, stop trusting it.
const MAX_OSC = 2048;
const STRING_C1 = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]); // DCS, SOS, OSC, PM, APC

/** Fresh state for one PTY: the terminal starts in ground state. */
export const oscScanState = () => ({ mode: 'ground', osc: false, body: '', trusted: false });

/** Scan `data` from `state` (mutated). Returns true when the chunk may have drawn. */
export function chunkMayDraw(data, state) {
  const s = String(data);
  // Not in ground state at the start: whatever was left open may act on this chunk.
  let draws = state.mode !== 'ground' && !((state.mode === 'str' || state.mode === 'strEsc') && state.osc && state.trusted && INERT.test(state.body));
  const endString = () => {
    if (!(state.osc && state.trusted && INERT.test(state.body))) draws = true;
    state.mode = 'ground'; state.osc = false; state.body = ''; state.trusted = false;
  };
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    switch (state.mode) {
      case 'ground':
        if (c === 0x1b) {
          // Only ESC ] in the same chunk is a trusted OSC start; a lone ESC at the end is not.
          if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x5d) { state.mode = 'str'; state.osc = true; state.body = ''; state.trusted = true; i += 1; }
          else { state.mode = 'esc'; draws = true; }
        } else if (c === 0x9b) { state.mode = 'csi'; draws = true; }
        else if (STRING_C1.has(c)) { state.mode = 'str'; state.osc = c === 0x9d; state.body = ''; state.trusted = false; draws = true; }
        else draws = true;
        break;
      case 'esc':
        draws = true;
        if (c === 0x5b) state.mode = 'csi';
        else if (c === 0x5d) { state.mode = 'str'; state.osc = true; state.body = ''; state.trusted = false; }
        else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) { state.mode = 'str'; state.osc = false; state.body = ''; state.trusted = false; }
        else if (c === 0x1b) state.mode = 'esc';
        else if (c >= 0x20 && c <= 0x2f) state.mode = 'esc'; // an intermediate: ESC ( B and the like
        else state.mode = 'ground';
        break;
      case 'csi':
        draws = true;
        if (c >= 0x40 && c <= 0x7e) state.mode = 'ground';
        else if (c === 0x1b) state.mode = 'esc';
        else if (c === 0x18 || c === 0x1a) state.mode = 'ground';
        break;
      case 'str':
        if (c === 0x07 && state.osc) endString();
        else if (c === 0x9c) endString();
        else if (c === 0x1b) {
          // A terminal acts on the string as soon as the ESC of its ESC \ arrives.
          if (!(state.osc && state.trusted && INERT.test(state.body))) draws = true;
          state.mode = 'strEsc';
        } else if (c === 0x18 || c === 0x1a || (c >= 0x80 && c <= 0x9f)) { draws = true; state.mode = 'ground'; state.osc = false; state.body = ''; state.trusted = false; }
        else if (state.body.length >= MAX_OSC) { draws = true; state.trusted = false; }
        else state.body += s[i];
        break;
      case 'strEsc':
        if (c === 0x5c) endString();
        else {
          // The ESC ended the string and starts a new sequence: look at this char from there.
          draws = true;
          state.mode = 'esc'; state.osc = false; state.body = ''; state.trusted = false;
          i -= 1;
        }
        break;
      default:
        draws = true;
        state.mode = 'ground';
    }
  }
  return draws;
}

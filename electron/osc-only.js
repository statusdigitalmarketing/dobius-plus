// Does a chunk of PTY output change what is on screen? Sam, 2026-11-05: with a question card up
// and a second one queued behind it, the queued call's status hooks print "working" then "needs"
// markers (OSC 777;dobius;...) into the tab, and the phone refused every tap as "The prompt
// changed" while the first question sat there unchanged. Those markers, and window titles, never
// draw a cell, so a chunk made only of them no longer moves the selector token's output count.
//
// Everything else counts, and so does anything uncertain. The scan follows the terminal's own
// parser across chunks, with the standard DEC/xterm transitions (C1 controls act from any state;
// C0 controls inside an escape or CSI execute without leaving it; NUL and DEL are ignored there),
// because a sequence opened in one chunk can take effect inside the next (Codex, five rounds). A
// chunk is let through only when it starts in ground state, or inside a title or status OSC this
// scan opened itself, and holds nothing but those, introduced by ESC ] in ground state.

// Window and icon titles (0, 1, 2) and Dobius's own tab-status markers.
const INERT = /^(?:[012];|777;dobius;)/;
// Longer than any title or marker we expect: past this, stop trusting it.
const MAX_OSC = 2048;

/** Fresh state for one PTY: the terminal starts in ground state. */
export const oscScanState = () => ({ mode: 'ground', osc: false, body: '', trusted: false });

const inertOsc = (st) => st.osc && st.trusted && INERT.test(st.body);
const isC0Exec = (c) => (c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f));

/** Scan `data` from `state` (mutated). Returns true when the chunk may have drawn. */
export function chunkMayDraw(data, state) {
  const s = String(data);
  // Not in ground state at the start: whatever was left open may act on this chunk.
  let draws = state.mode !== 'ground' && !((state.mode === 'str' || state.mode === 'strEsc') && inertOsc(state));
  const toString = (osc, trusted) => { state.mode = 'str'; state.osc = osc; state.body = ''; state.trusted = trusted; };
  const toGround = () => { state.mode = 'ground'; state.osc = false; state.body = ''; state.trusted = false; };
  const endString = () => { if (!inertOsc(state)) draws = true; toGround(); };
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    // xterm's decoder drops a byte order mark before its parser sees anything, so it does too.
    if (c === 0xfeff) continue;
    // Transitions that apply from any state.
    if (c === 0x18 || c === 0x1a) { draws = true; toGround(); continue; } // CAN, SUB
    if (c >= 0x80 && c <= 0x9f) {
      draws = true;
      if (c === 0x9c && (state.mode === 'str' || state.mode === 'strEsc')) { toGround(); continue; } // ST
      if (c === 0x9b) { toGround(); state.mode = 'csi'; continue; }
      if (c === 0x9d) { toString(true, false); continue; }
      if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) { toString(false, false); continue; }
      toGround();
      continue;
    }
    switch (state.mode) {
      case 'ground':
        if (c === 0x1b) {
          // Only ESC ] read together in ground state opens a string this scan can vouch for.
          if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x5d) { toString(true, true); i += 1; }
          else { state.mode = 'esc'; draws = true; }
        } else draws = true;
        break;
      case 'esc':
        draws = true;
        if (c === 0x1b || c === 0x7f || isC0Exec(c)) break; // stays in escape
        if (c === 0x5b) state.mode = 'csi';
        else if (c === 0x5d) toString(true, false);
        else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) toString(false, false);
        else if (c >= 0x20 && c <= 0x2f) state.mode = 'escInt';
        else toGround();
        break;
      case 'escInt':
        draws = true;
        if (c === 0x1b) state.mode = 'esc';
        else if (c === 0x7f || isC0Exec(c) || (c >= 0x20 && c <= 0x2f)) break;
        else toGround();
        break;
      case 'csi':
        draws = true;
        if (c === 0x1b) state.mode = 'esc';
        else if (c >= 0x40 && c <= 0x7e) toGround();
        break;
      case 'str':
        if (c === 0x07 && state.osc) endString();
        else if (c === 0x1b) {
          // A terminal acts on the string as soon as the ESC of its ESC \ arrives.
          if (!inertOsc(state)) draws = true;
          state.mode = 'strEsc';
        } else if (c < 0x20 || c === 0x7f) { /* ignored inside a string */ }
        else if (state.body.length >= MAX_OSC) { draws = true; state.trusted = false; }
        else state.body += s[i];
        break;
      case 'strEsc':
        if (c === 0x5c) endString();
        else {
          // The ESC ended the string and starts a new sequence: look at this char from there.
          draws = true;
          toGround();
          state.mode = 'esc';
          i -= 1;
        }
        break;
      default:
        draws = true;
        toGround();
    }
  }
  return draws;
}

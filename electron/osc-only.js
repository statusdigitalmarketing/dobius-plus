// Does a chunk of PTY output change what is on screen? Sam, 2026-11-05: with a question card up
// and a second one queued behind it, the queued call's status hooks print "working" then "needs"
// markers (OSC 777;dobius;...) into the tab, and the phone refused every tap as "The prompt
// changed" while the first question sat there unchanged. Those markers, and window titles, never
// draw a cell, so they no longer move the selector token's output count.
//
// Only those: every other OSC counts (a palette change repaints existing cells: Codex), and so
// does anything the scan is unsure of. The scan keeps its state across chunks, and an OSC is only
// let through once its terminator shows it was one of the inert kinds.

// Window and icon titles (0, 1, 2) and Dobius's own tab-status markers.
const INERT = /^(?:[012];|777;dobius;)/;
// Longer than any title or marker we expect: past this, stop trusting it and count it.
const MAX_OSC = 2048;

/** Fresh state for one PTY. */
export const oscScanState = () => ({ inOsc: false, escInOsc: false, body: '' });

/**
 * Scan `data` from `state` (mutated). Returns true when the chunk may have drawn: any byte outside
 * an OSC, an OSC that is not a title or a status marker, a C1 control inside one, or one that ran
 * too long.
 */
export function chunkMayDraw(data, state) {
  let draws = false;
  const s = String(data);
  const close = () => { if (!INERT.test(state.body)) draws = true; state.inOsc = false; state.escInOsc = false; state.body = ''; };
  const abandon = () => { draws = true; state.inOsc = false; state.escInOsc = false; state.body = ''; };
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (state.inOsc) {
      if (state.escInOsc) {
        if (c === 0x5c) { close(); continue; } // ESC \ ends it
        // ESC then anything else: not a clean end. Count it, and look at this char again outside.
        abandon();
        i -= 1;
        continue;
      }
      if (c === 0x07) { close(); continue; }
      if (c === 0x1b) { state.escInOsc = true; continue; }
      // C1 controls (ST 0x9c among them) and CAN / SUB: a terminal may end the string here and act
      // on what follows, so none of it is trusted (Codex P1).
      if ((c >= 0x80 && c <= 0x9f) || c === 0x18 || c === 0x1a) { abandon(); continue; }
      if (state.body.length >= MAX_OSC) { abandon(); continue; }
      state.body += s[i];
      continue;
    }
    if (c === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5d) { state.inOsc = true; state.body = ''; i += 1; continue; }
    draws = true;
  }
  return draws;
}

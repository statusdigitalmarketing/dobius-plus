// Does a chunk of PTY output change what is on screen? Operating system commands (ESC ] ... BEL
// or ESC ] ... ESC \) set the window title, our own tab-status markers (OSC 777;dobius;...) and
// the like: they never draw a cell. Sam, 2026-11-05: with a question card up and a second one
// queued behind it, the queued call's status hooks print "working" then "needs" markers into the
// tab, and the phone refused every tap as "The prompt changed" while the first question sat there
// unchanged. Only output that can draw moves the selector token's output count.
//
// The scan carries its state across chunks: an OSC split over two chunks is still an OSC. Anything
// it is unsure of (a lone ESC at the end outside an OSC) counts as drawing, which is the safe side.

/** Fresh state for one PTY. */
export const oscScanState = () => ({ inOsc: false, escInOsc: false });

/**
 * Scan `data` from `state` (mutated). Returns true when any byte outside an OSC string arrived,
 * i.e. the chunk may have drawn something.
 */
export function chunkMayDraw(data, state) {
  let draws = false;
  const s = String(data);
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (state.inOsc) {
      if (state.escInOsc) {
        state.escInOsc = false;
        if (c === 0x5c) { state.inOsc = false; continue; } // ESC \ ends it
        // ESC then something else: the OSC was cut off; that ESC starts a new sequence.
        state.inOsc = false;
        i -= 1; // look at this character again, outside the OSC
        draws = true;
        continue;
      }
      if (c === 0x07) { state.inOsc = false; continue; }
      if (c === 0x1b) { state.escInOsc = true; continue; }
      if (c === 0x18 || c === 0x1a) { state.inOsc = false; continue; } // CAN / SUB abort it
      continue;
    }
    if (c === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5d) { state.inOsc = true; i += 1; continue; }
    draws = true;
  }
  return draws;
}

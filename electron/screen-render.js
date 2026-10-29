// Render a raw PTY byte stream into the SCREEN a real terminal would show,
// using xterm's own headless emulator (v1.0.62).
//
// Why this exists: the mobile selector popups were parsed by regexing an
// ANSI-stripped rolling buffer. That works for a frame drawn in one pass, but
// Ink repaints INCREMENTALLY: on a multi-question AskUserQuestion, question
// two arrives as cursor-positioned cell updates that never form a complete
// line in a linear strip, so the second question's popup simply never
// appeared on the phone (Sam, 8/14). An emulator replays the same bytes the
// way the terminal did: absolute positioning lands, erase sequences actually
// ERASE (so an answered prompt disappears instead of lingering as "stale"
// text), and reading the grid back gives the true current screen.
//
// Main-process only. One pooled Terminal, reset per call: construction is the
// expensive part, reset is cheap. Callers are the mobile selector paths,
// which run at most a few times per second for one tab.

// @xterm/headless ships CJS with no named ESM exports; default-import and
// destructure (same interop pattern Node and Electron main both honor).
import headless from '@xterm/headless';

const { Terminal } = headless;

// Wider and taller than any real pty this app spawns, so absolute column
// positioning from the CLI's believed width always lands inside the grid and
// a full frame always fits without scrolling rows off mid-frame.
const COLS = 220;
const ROWS = 120;

let pooled = null;

// Renders share ONE pooled terminal, so they must run one at a time: two
// concurrent selector probes (tab A and tab B, or two phones) would otherwise
// interleave reset/write on the same grid and tab A's probe could read tab
// B's screen, surfacing B's dialog on A's chat where a tap answers the wrong
// prompt (Codex High). A render is fast (<50ms typical, 750ms worst), so a
// simple promise chain is enough.
let renderChain = Promise.resolve();

/**
 * @param raw string | Uint8Array of raw PTY output (a rolling-buffer tail)
 * @returns Promise<string[] | null> the ROWS screen lines (right-trimmed),
 *          or null when the emulator failed; callers fall back to the old
 *          strip-and-regex path so a headless bug can never LOSE a popup
 *          that path would have found.
 */
export function renderScreenLines(raw, opts) {
  const run = renderChain.then(() => renderScreenLinesNow(raw, opts));
  // renderScreenLinesNow never rejects, but keep the chain unbreakable anyway.
  renderChain = run.then(() => undefined, () => undefined);
  return run;
}

function renderScreenLinesNow(raw, { timeoutMs = 750 } = {}) {
  return new Promise((resolve) => {
    let term;
    try {
      if (!pooled) {
        pooled = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true, logLevel: 'off' });
      }
      term = pooled;
      term.reset();
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok) { resolve(null); return; }
      try {
        const out = [];
        const buf = term.buffer.active;
        for (let i = 0; i < ROWS; i += 1) out.push(buf.getLine(i)?.translateToString(true) ?? '');
        // The multi-question tab bar (`← ☐ Color ☐ Size ✔ Submit →`) marks
        // the CURRENT question with a background colour, which plain text
        // loses. Report, per tab-bar row, the runs of highlighted text, so
        // the parser knows which question is showing. Non-enumerable: it
        // never rides along in a payload.
        const highlights = {};
        for (let i = 0; i < ROWS; i += 1) {
          if (!/[☐☒✔]/.test(out[i])) continue;
          const line = buf.getLine(i);
          const runs = [];
          let run = '';
          for (let x = 0; x < COLS; x += 1) {
            const cell = line?.getCell(x);
            if (!cell) break;
            if (cell.getWidth() === 0) continue; // second half of a wide char
            if (!cell.isBgDefault()) run += cell.getChars() || ' ';
            else if (run) { runs.push(run.trim()); run = ''; }
          }
          if (run) runs.push(run.trim());
          if (runs.length) highlights[i] = runs.filter(Boolean);
        }
        Object.defineProperty(out, 'highlights', { value: highlights });
        resolve(out);
      } catch {
        resolve(null);
      }
    };
    // A hung write must not wedge the caller; the fallback path takes over.
    // Dispose the pooled instance on timeout: the chain advances when this
    // promise settles, and a still-running write from THIS render would
    // otherwise keep mutating the shared grid under the next render's feet
    // (Codex round 2). The next call constructs a fresh terminal.
    const t = setTimeout(() => {
      try { pooled?.dispose(); } catch { /* already broken */ }
      pooled = null;
      finish(false);
    }, timeoutMs);
    try {
      term.write(raw, () => { clearTimeout(t); finish(true); });
    } catch {
      clearTimeout(t);
      finish(false);
    }
  });
}

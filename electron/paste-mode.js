// Bracketed paste mode tracked over a terminal's whole output (team delivery,
// docs/team-communicator.md). Pure, so it is tested without node-pty.
// Mode 2004, also inside a combined list (ESC [ ? 1004 ; 2004 h). RIS (ESC c)
// resets the terminal, mode included.
const MODE_SET_RE = /\x1b\[\?([0-9;]*)([hl])|\x1bc/g;
// An unfinished set at the end of a chunk, carried into the next one.
const MODE_TAIL_RE = /\x1b(?:\[(?:\?[0-9;]{0,30})?)?$/;

/**
 * Bracketed paste mode tracked across output chunks (team delivery reads it: on a long-running tab the switch that
 * turned it on has long left the bounded replay buffer, so a fresh render cannot tell). Pure: returns the new state.
 * @param {{ on: boolean, carry: string }} state
 */
export function trackPasteMode(state, data) {
  const text = (state?.carry || '') + String(data || '');
  let on = !!state?.on;
  for (const m of text.matchAll(MODE_SET_RE)) {
    if (m[0] === '\x1bc') on = false;
    else if (m[1].split(';').includes('2004')) on = m[2] === 'h';
  }
  const tail = MODE_TAIL_RE.exec(text);
  return { on, carry: tail ? tail[0] : '' };
}

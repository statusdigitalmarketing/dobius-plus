// Per-row facts about a terminal screen, read off an xterm buffer (headless in main, the window's own xterm in the
// page): one copy of the rules, so a screen rebuilt in main and one read from a window are judged the same way
// (electron/screen-render.js, electron/window-screen.js). Cells use xterm's IBufferCell API (both builds have it).

/** getLine(i) -> IBufferLine or undefined, for rows 0..height-1. Returns { ends, dimFrom, firstWords, firstColored }. */
export function rowFacts(getLine, height, width) {
  const ends = [];
  const firstWords = [];
  // Where each row's trailing dim text starts, or -1: Claude draws its
  // placeholder and ghost suggestion dim, and typed text never.
  const dimFrom = [];
  // Whether each row's first visible character is drawn in a colour
  // (not the default foreground): Claude's own warnings are, typed and
  // quoted text is not (chat-service's timer check).
  const firstColored = [];
  for (let i = 0; i < height; i += 1) {
    const line = getLine(i);
    let colored = false;
    let end = 0;
    let start = -1;
    let wordEnd = -1;
    let dimAt = -1;
    for (let x = 0; x < width; x += 1) {
      const cell = line?.getCell(x);
      if (!cell) break;
      const w = cell.getWidth();
      if (w === 0) continue; // the second half of a wide glyph
      // A cell's BASE character decides: zero-width marks attach to the
      // cell before them, so a space can read " \u200E" (Codex P2).
      const chars = cell.getChars();
      const blank = !chars || chars[0] === ' ';
      if (!blank) {
        if (!cell.isDim()) dimAt = -1;
        else if (dimAt === -1) dimAt = x;
        end = x + w;
        if (start === -1) { start = x; colored = !cell.isFgDefault(); }
        if (wordEnd === -1) continue;
      } else if (start !== -1 && wordEnd === -1) wordEnd = x;
    }
    ends.push(end);
    dimFrom.push(dimAt);
    firstColored.push(colored);
    firstWords.push(start === -1 ? 0 : (wordEnd === -1 ? end : wordEnd) - start);
  }
  return { ends, dimFrom, firstWords, firstColored };
}

// Parse a Claude Code interactive selection prompt out of a terminal's recent
// RAW output (ANSI included) so the mobile Chat view can surface the options as
// tappable buttons. Pure (no I/O), mirroring terminal-status.js.
//
// Claude renders selection prompts as a numbered list with a cursor marker (❯)
// on the highlighted row, e.g.:
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. Yes, and don't ask again this session
//     3. No, and tell Claude what to do differently
//
// Safety: the mobile client sends the ABSOLUTE option number the user tapped
// (matching the visible label), never relative arrow navigation, so a parse
// error in the cursor position can never select a DIFFERENT option than the
// label. selectedIndex is returned for display only.

import { createHash } from 'node:crypto';

const CSI_RE = /^\x1b\[([0-9;?]*)([ -/]*)([@-~])/;

// Linear scanner, not regex passes: Ink lays text out with CURSOR MOTION, not
// spaces. Real AskUserQuestion frames position every word with CHA (CSI n G)
// and rows with CUD (CSI n B), so deleting escapes glued words ("2.Blue",
// "Thecolorblue") and option matching never fired: interactive prompts simply
// never appeared on the phone (Sam's report). The scanner tracks an
// approximate column (escapes don't count) and renders cursor motion as the
// whitespace it visually produces:
//   CSI n C (forward)        -> n spaces
//   CSI n G (column, ahead)  -> pad spaces up to that column
//   CSI n G (column 1)       -> line restart (\r)
//   CSI n G (column, behind) -> single space (word boundary, approx col)
//   CSI n B / E (down)       -> newline, indented back to the current column
// Everything else (SGR colors, erases, OSC/DCS, 2-char escapes) is dropped.
export function stripAnsi(s) {
  const src = String(s == null ? '' : s);
  let out = '';
  let col = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\x1b') {
      const next = src[i + 1];
      if (next === ']') { // OSC ... (BEL or ST terminated)
        const bel = src.indexOf('\x07', i + 2);
        const st = src.indexOf('\x1b\\', i + 2);
        const end = Math.min(bel === -1 ? Infinity : bel + 1, st === -1 ? Infinity : st + 2);
        i = end === Infinity ? src.length : end;
        continue;
      }
      if (next === 'P' || next === 'X' || next === '^' || next === '_') { // DCS/SOS/PM/APC ... ST
        const st = src.indexOf('\x1b\\', i + 2);
        i = st === -1 ? src.length : st + 2;
        continue;
      }
      if (next === '[') {
        const m = CSI_RE.exec(src.slice(i, i + 32));
        if (m) {
          const n = parseInt(m[1].split(';')[0] || '', 10);
          const fin = m[3];
          if (fin === 'C') {
            const k = Math.min(n || 1, 400);
            out += ' '.repeat(k); col += k;
          } else if (fin === 'G') {
            const target = Math.max(1, n || 1) - 1;
            if (target > col) { out += ' '.repeat(Math.min(target - col, 400)); col = target; }
            else if (target === 0 && col > 0) { out += '\r'; col = 0; }
            else if (target < col) { out += ' '; col = target; }
          } else if (fin === 'B' || fin === 'E') {
            out += `\n${' '.repeat(Math.min(fin === 'B' ? col : 0, 400))}`;
            if (fin === 'E') col = 0;
          }
          i += m[0].length;
          continue;
        }
        i += 2; // malformed CSI: drop the ESC[ and continue
        continue;
      }
      i += 2; // 2-char escape
      continue;
    }
    if (ch === '\n' || ch === '\r') { out += ch; col = 0; i += 1; continue; }
    out += ch;
    col += 1;
    i += 1;
  }
  return out;
}

// optional cursor marker, a number, `.`/`)`, then a non-empty label.
// Group 1 = leading whitespace (for the number-column indent), 2 = cursor,
// 3 = number, 4 = label.
const OPT_RE = /^(\s*)([❯›»▶>*]?)\s*(\d+)[.)]\s+(\S.*?)\s*$/u;
const CURSOR_CHARS = new Set(['❯', '›', '»', '▶', '>']);

// Column where an option line's NUMBER starts. Cursor rows ("❯ 1.") and plain
// rows ("  2.") have different leading whitespace but the digit column aligns,
// so this is the stable indent reference for description lines.
function numberCol(line) {
  const m = line.match(OPT_RE);
  if (!m) return -1;
  return line.indexOf(m[3], m[1].length + m[2].length);
}
function leadingWs(line) {
  const m = line.match(/^\s*/);
  return m ? m[0].length : 0;
}
// Trailing lines allowed after the options (selector navigation chrome, not
// prose): arrow glyphs or common hint words.
const HINT_RE = /[↑↓←→]|\b(enter|esc|escape|select|selection|confirm|cancel|navigate|arrows?|space|tab|toggle|use|choose|press|return|move)\b/i;
// A horizontal-rule row (box-drawing dashes). Claude Code 2.1.x draws one
// INSIDE AskUserQuestion blocks (between the answers and "Chat about this")
// and as frame borders, so a rule is layout chrome, never prose.
const RULE_RE = /^\s*[─-╿]{3,}\s*$/;

/**
 * @param {string} rawBuf recent raw terminal output (a screenful+ is enough)
 * @returns {{prompt:string, options:{num:number,label:string}[], selectedIndex:number}|null}
 */
export function parseSelector(rawBuf) {
  if (!rawBuf || typeof rawBuf !== 'string') return null;
  // Treat a bare \r as a line break too: Ink positions rows with lone
  // carriage returns (no \n), so deleting \r used to fuse an option line with
  // its description line ("❯ 1. Red   The color red") and hide the block.
  // A \r RUN and \r+\n collapse to ONE break: Ink ends rows with "\r\r\n",
  // and splitting that into phantom blank lines broke the block scan.
  const lines = stripAnsi(rawBuf).split(/\r*\n|\r+/);

  // Find the LAST block of option lines (scan from the bottom). One blank line
  // inside the block is tolerated, and so are short runs of DESCRIPTION lines
  // indented deeper than the option numbers: AskUserQuestion renders
  //   ❯ 1. Ship public now
  //        Publishes the release immediately...
  //     2. Keep local
  // and the old strictly-contiguous scan broke at the description line, so
  // question popups never parsed on mobile (Sam's v1.0.51 bug 1). The indent
  // requirement keeps unrelated prose (flush-left) from gluing two numbered
  // fragments into one fake selector.
  const MAX_CONT = 4; // max consecutive description lines between options
  let end = -1;
  let start = -1;
  let sawBlank = false;
  let contRun = 0;
  let sawInBlockDesc = false; // any description line BETWEEN options (AskUserQuestion style)
  let belowCol = -1; // number column of the nearest option line BELOW the cursor position
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (OPT_RE.test(lines[i])) {
      if (end === -1) end = i;
      start = i;
      sawBlank = false;
      contRun = 0;
      belowCol = numberCol(lines[i]);
    } else if (end !== -1) {
      const t = lines[i].trim();
      if (RULE_RE.test(lines[i])) continue; // in-block divider (AskUserQuestion 2.1.x)
      if (t === '' && !sawBlank) { sawBlank = true; continue; }
      if (t !== '' && contRun < MAX_CONT && belowCol >= 0 && leadingWs(lines[i]) > belowCol) {
        contRun += 1;
        sawInBlockDesc = true;
        continue;
      }
      break;
    }
  }
  if (end === -1) return null;

  const options = [];
  let selectedIndex = -1;
  const seenNums = new Set();
  for (let i = start; i <= end; i += 1) {
    const m = lines[i].match(OPT_RE);
    if (!m) continue;
    const cursor = m[2];
    const num = parseInt(m[3], 10);
    const label = m[4].trim();
    if (seenNums.has(num)) continue; // ignore accidental duplicate numbers
    seenNums.add(num);
    if (cursor && CURSOR_CHARS.has(cursor)) selectedIndex = options.length;
    options.push({ num, label });
  }
  if (options.length < 2) return null; // need at least two choices to be a selector

  // REQUIRE a cursor marker on one option. A real Claude TUI selector always
  // draws the ❯ pointer on the active row; a numbered list in Claude's PROSE
  // ("here are the options: 1. ... 2. ...") never does. Without this, prose
  // lists would render fake tappable buttons that inject a stray digit. A
  // selector rendered with inverse-video instead of ❯ would be missed, but a
  // false negative is safe (the user just uses the Term fallback). Codex.
  if (selectedIndex === -1) return null;

  // A LIVE selector is the last interactive element on screen. After the options
  // there may be short navigation-hint chrome ("↑/↓ select, enter to confirm")
  // or a bare prompt caret, but NOT prose: the PTY buffer is append-only, so
  // once a selector is ANSWERED Claude's response text lands after it. Reject if
  // any trailing line looks like prose rather than hint chrome, so an
  // already-answered selector isn't shown as live. Codex.
  // Trailing lines: a description under the LAST option is only legitimate for
  // AskUserQuestion-style blocks (which put one under EVERY option), so gate it
  // on sawInBlockDesc; a plain permission selector followed by indented output
  // (e.g. code in Claude's response) must still read as answered/stale. The
  // desc phase ends at the first blank/caret/hint line, so indented lines that
  // come after chrome are response text, not description. Codex v1.0.51.
  //
  // Accepted residual (Codex, Low): an ANSWERED AskUserQuestion followed by
  // <=3 indented response lines with NO blank/caret/chrome between still reads
  // live, until more output arrives or the rolling tail drops the frame. A
  // description line and an indented response line are textually identical, so
  // shrinking MAX_CONT would instead false-negative real WRAPPED descriptions
  // (bug 1 again); a stale tap merely puts a digit in the input box.
  const endCol = numberCol(lines[end]);
  let trailCont = 0;
  let descPhase = sawInBlockDesc;
  for (const l of lines.slice(end + 1)) {
    const t = l.trim();
    if (t === '') { descPhase = false; continue; }                      // blank
    // Frame border / divider. Accepted residual (Codex, Low): an ANSWERED
    // selector followed by a rule row reads live until the next output line,
    // because a LIVE boxed prompt's bottom border after its footer is the
    // same shape; nulling rules here would break boxed prompts entirely.
    if (RULE_RE.test(l)) { descPhase = false; continue; }
    if (/^[>❯›»▶$#%*.·:\s]+$/.test(t)) { descPhase = false; continue; } // bare caret / punctuation
    if (descPhase && trailCont < MAX_CONT && endCol >= 0 && leadingWs(l) > endCol) { trailCont += 1; continue; }
    // Otherwise allow only SHORT navigation-hint chrome (arrows or hint words).
    // A longer line, or any line without a hint token (e.g. "OK", a response),
    // means the selector was answered and is stale, so return null. Codex.
    // 60, not 40: the real AskUserQuestion footer "Enter to select · ↑/↓ to
    // navigate · Esc to cancel" is 50 chars once cursor-forward spacing is
    // restored, and the old cap read it as prose (popup never appeared).
    if (t.length <= 60 && HINT_RE.test(t)) { descPhase = false; continue; }
    return null;
  }

  // The prompt/question is the nearest non-empty line above the block.
  let prompt = '';
  for (let i = start - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t) { prompt = t; break; }
  }
  return { prompt, options, selectedIndex };
}

/**
 * The whimsical gerund Claude Code's spinner shows while working: the
 * "Flibbertigibbeting…" / "Discombobulating…" / "Frolicking…" line. Sam asked
 * for these on the phone board because they are half the fun of watching a
 * session think.
 *
 * No word list: the CLI ships hundreds (its 2.1.227 binary carries a
 * length-prefixed table: "Flambéing", "Fiddle-faddling", "Gallivanting", ...)
 * and it grows per release. Match the LINE SHAPE instead, taken from a REAL
 * captured frame on this machine (do not trust the docs or memory; the first
 * version anchored on "esc to interrupt" being on the same line, and on
 * 2.1.227 it is not, it lives on a separate footer row):
 *
 *     ✳ Proofing… (3s · ↓ 95 tokens)
 *     · Burrowing…
 *
 * So the anchor is the SPINNER GLYPH opening the line (the CLI animates
 * through · ✢ ✳ ✶ ✻ ✽, older builds used *), then the capitalized gerund,
 * then the ellipsis. The glyph is what keeps ordinary prose ending in "ing…"
 * from counting.
 *
 * Verb charset covers the real table: letters (accented: Flambéing),
 * hyphens (Fiddle-faddling), apostrophes, spaces (multi-word entries). The
 * LAST match in the tail wins, because the buffer is a rolling scrollback
 * where earlier repaints (and earlier turns) linger above.
 *
 * @param raw ANSI terminal buffer (tail is enough; caller slices)
 * @returns the gerund ("Flibbertigibbeting") or '' when no spinner is on screen
 */
const SPINNER_LINE_RE = /^\s*[·✢✳✶✻✽*]\s+([A-Z][A-Za-zÀ-ɏ' -]{1,40}ing)(?:…|\.\.\.)[ \t]*(?:\(([^)\n]{0,160})\))?/gm;
export function spinnerVerb(raw) {
  return spinnerStatus(raw)?.verb || '';
}

/**
 * The whole spinner line: the gerund plus what the parenthetical after it
 * says, so a chat view can show the same live meter the terminal does.
 *
 *     ✳ Proofing… (3s · ↓ 95 tokens)
 *     ✻ Whirlpooling… (1m 12s · ↑ 2.3k tokens · thinking)
 *
 * @returns null with no spinner on screen, else { verb, seconds, tokens, dir }
 *   where seconds/tokens are numbers or null and dir is 'up' | 'down' | null.
 */
export function spinnerStatus(raw) {
  if (!raw) return null;
  // Strip first, then window: a repainting TUI is mostly escape bytes, so a
  // raw slice holds almost no text (the claudeTuiPresent lesson, v1.0.56).
  const tail = stripAnsi(String(raw).slice(-65536)).slice(-4096);
  let last = null;
  SPINNER_LINE_RE.lastIndex = 0;
  for (const m of tail.matchAll(SPINNER_LINE_RE)) last = m;
  if (!last) return null;
  const detail = last[2] || '';
  // Elapsed leads the parenthetical: "3s", "1m 12s", "1h 2m 3s".
  const t = /^\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?(?=\s*(?:·|$))/.exec(detail);
  const seconds = t && (t[1] || t[2] || t[3])
    ? (Number(t[1] || 0) * 3600) + (Number(t[2] || 0) * 60) + Number(t[3] || 0)
    : null;
  const k = /([↑↓])\s*([\d.,]+)\s*([kKmM])?\s*tokens/.exec(detail);
  let tokens = null;
  if (k) {
    const n = Number(k[2].replace(/,/g, ''));
    const mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[k[3]] || 1;
    if (Number.isFinite(n)) tokens = Math.round(n * mult);
  }
  return { verb: last[1].trim(), seconds, tokens, dir: k ? (k[1] === '↑' ? 'up' : 'down') : null };
}

/**
 * Parse a selector from RENDERED SCREEN LINES (v1.0.62), the output of
 * electron/screen-render.js's headless-xterm replay. This is the primary
 * mobile popup path now; the strip-and-regex parseSelector above remains as
 * the fallback when the emulator fails.
 *
 * Why a separate parser: rendered screens are CLEAN. Ink's incremental
 * repaints (which drop cells of new text into an old frame, invisible to a
 * linear strip: the multi-question AskUserQuestion bug) have already been
 * applied, and its erase sequences have already REMOVED answered prompts.
 * So this parser needs none of the contamination heuristics above; its one
 * liveness rule is that a live prompt always shows its hint footer
 * ("Enter to select · ... · Esc to cancel") near the block.
 *
 * Shapes verified against captured 2.1.233 frames (fixtures
 * askq-multi-*.bin): single question, question 2 of a multi-question call
 * (tab bar "← ☒ Color ☐ Size ✔ Submit →" above), and the final
 * "Ready to submit your answers?" screen, which is itself a numbered block.
 */
const SCREEN_OPTION_RE = /^\s*(❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const SCREEN_HINT_RE = /Enter to (?:select|confirm)|Esc to cancel|to navigate/i;
const SCREEN_RULE_RE = /^[\s─━-]{6,}$/;
const SCREEN_CHROME_RE = /[☐☒]|^\s*←|^\s*→\s*$/;

export function parseSelectorFromScreen(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  // Liveness anchor, two forms:
  //  a) the hint footer ("Enter to select · ... · Esc to cancel"): find the
  //     LAST one on screen;
  //  b) no footer, but the screen ENDS with a ❯-cursor numbered block AND
  //     the multi-question tab bar (☐/☒ checkboxes) is on screen above it:
  //     the wizard's "Ready to submit your answers?" step draws no footer at
  //     all (captured 2.1.233 fixture), and the tab bar is what separates it
  //     from Claude QUOTING a selector in prose at the end of a message,
  //     which must never become tappable fake options (Codex High). The
  //     emulator honoring Ink's erases already removed any ANSWERED block.
  let hintIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (SCREEN_HINT_RE.test(lines[i])) { hintIdx = i; break; }
  }
  if (hintIdx === -1) {
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last -= 1;
    const hasTabBar = last >= 0 && lines.slice(0, last).some((l) => /[☐☒]/.test(l));
    if (last >= 0 && hasTabBar && SCREEN_OPTION_RE.test(lines[last])) {
      hintIdx = last + 1;
    }
  }
  if (hintIdx === -1) return null;

  // Walk upward from the hint collecting the numbered block. Rules and blank
  // lines may sit between the hint and the options (the frame draws a rule
  // above the escape-hatch options), and desc lines sit under their option.
  const options = [];
  let blockTop = -1;
  // Indented rows under an option: its description, or the rest of a label
  // too long for one row. Read bottom-up, so they arrive before their option.
  let pendingDetail = [];
  let pendingEnds = []; // the column each detail row ends at, for reflow
  const detailEnds = new Map();
  for (let i = hintIdx - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || SCREEN_RULE_RE.test(t)) {
      // A blank or rule row INSIDE a description is a real separator: kept
      // as written, so two commands around it can never be joined into one
      // (Codex P2, twice). End column 0 means "never a wrap".
      if (pendingDetail.length) { pendingDetail.push(t); pendingEnds.push(0); }
      continue;
    }
    const m = line.match(SCREEN_OPTION_RE);
    if (m) {
      const opt = { num: Number(m[2]), label: m[3].trim() };
      // Blank or rule rows between the option and its description: chrome.
      while (pendingDetail.length && (pendingDetail[pendingDetail.length - 1] === '' || SCREEN_RULE_RE.test(pendingDetail[pendingDetail.length - 1]))) { pendingDetail.pop(); pendingEnds.pop(); }
      if (pendingDetail.length) { opt.detail = pendingDetail.reverse().join('\n'); detailEnds.set(opt, pendingEnds.reverse()); }
      pendingDetail = [];
      pendingEnds = [];
      options.unshift(opt);
      blockTop = i;
      continue;
    }
    // Non-numbered line: a description under an option (indented) keeps the
    // walk going while we are inside the block; anything else above the
    // topmost option ends the block.
    if (/^\s{3,}\S/.test(line)) { pendingDetail.push(t); pendingEnds.push(colOf(lines, i)); continue; } // option description
    if (options.length === 0) { pendingDetail = []; pendingEnds = []; continue; } // hint chrome between hint and block
    break;
  }
  if (options.length === 0) return null;
  // Numbering must start at 1 and ascend; a random numbered list in prose
  // lacks the hint footer anyway, but keep the shape check.
  for (let i = 0; i < options.length; i += 1) {
    if (options[i].num !== i + 1) return null;
  }
  // The ❯ cursor row, read directly off the block's screen rows. It is
  // REQUIRED in every form: a real Claude Code selector always renders one,
  // and a numbered list in prose (even one followed by "Press Enter to
  // confirm when ready", which trips the hint regex: Codex High) never does.
  let sel = -1;
  for (let i = blockTop; i < hintIdx; i += 1) {
    const m = lines[i]?.match(SCREEN_OPTION_RE);
    if (m && m[1]) { sel = Number(m[2]) - 1; break; }
  }
  if (sel === -1) return null;

  // The terminal's width, as wide as its widest row (the frame's rule).
  const frameW = lines.reduce((w, l, i) => Math.max(w, colOf(lines, i)), 0);
  const steps = screenSteps(lines, blockTop, hintIdx, frameW);
  // An AskUserQuestion question is prose that Claude wrapped at the terminal
  // width: re-flow its rows into one paragraph, or a phone card shows it
  // broken mid-sentence. Permission prompts and the review step keep their
  // rows (a command, its description, the question; answers one per line).
  const prose = !!steps && steps.current < steps.total;
  // Option descriptions likewise (Claude wrapped them at the terminal width).
  const opts = prose ? options.map((o) => (o.detail ? { ...o, detail: reflow(o.detail.split('\n'), detailEnds.get(o), frameW) } : o)) : options;
  const out = { prompt: screenPrompt(lines, blockTop, prose, frameW), options: opts, selectedIndex: sel };
  if (steps) out.steps = steps;
  // For selectorFingerprint only: the uncapped screen above the block, so two
  // same-worded prompts for different commands or edits never match. Not
  // enumerable, so it stays out of every JSON payload and card.
  Object.defineProperty(out, 'context', {
    value: lines.slice(Math.max(0, blockTop - SCREEN_CONTEXT_ROWS), blockTop).map((l) => l.trimEnd()).join('\n'),
  });
  return out;
}

/**
 * The AskUserQuestion tab bar above a block (`← ☐ Color ☐ Size ✔ Submit →`)
 * as { labels, answered, current, total }: `labels`/`answered` per question,
 * `current` the question showing (0-based), or `total` on the "Ready to
 * submit" review step. The showing tab is the one drawn with a background
 * colour (screen-render's `highlights`); without that information (an older
 * caller, a plain string array) the first unanswered question is assumed.
 * null when there is no tab bar.
 */
// A tab bar row starts with a tab item once its ← → arrows are set aside: a
// line of prose with checkboxes in it ("Todo: ☐ Cleanup ☐ Verify") is not
// one (Codex). Arrows INSIDE a header ("Dev→Prod") are allowed (Codex P2). A plain linear test: a regex here backtracked exponentially on a
// crafted row and froze the main process (Codex P1).
function isTabBar(line) {
  const t = line.trim().replace(/^←\s*/, '').replace(/\s*→$/, '');
  return /^[☐☒✔]/.test(t);
}
// Columns a row takes, not UTF-16 units: combining marks and zero-width
// characters take none (security review), and East Asian wide glyphs and
// emoji take two (Codex P2: counted as one, a CJK row looked narrower than
// a short quoted rule above it). Overcounting only ever drops a stepper.
// An ESTIMATE: real screens use the emulator's exact columns (colOf).
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
function rowWidth(s) {
  let w = 0;
  for (const ch of s.trimEnd().replace(/[\p{M}\u200B-\u200D\u2060\uFEFF]/gu, '')) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}
// The column row i ends at: the emulator's own answer when screen-render gave
// one (exact), else this estimate (plain string arrays, tests).
function colOf(lines, i) {
  const e = Array.isArray(lines.ends) ? lines.ends[i] : undefined;
  return typeof e === 'number' ? e : rowWidth(lines[i]);
}
function screenSteps(lines, blockTop, hintIdx = blockTop, frameW = 0) {
  // The tab bar sits between the frame's rule and the question: never look
  // past a rule (a permission prompt's border), so text above it can't count.
  // The bar is the FIRST row of the frame, right under its rule (or the top
  // of the screen). Anything below it is the question: a line starting with
  // a checkbox, a quoted bar, a heredoc in a permission prompt. Choosing
  // among rows that merely look like bars lost three rounds (Codex P2). The
  // frame's rule starts at column 0 and spans the terminal, so it is at least
  // as long as every row under it: a permission prompt's indented heredoc, or
  // a short rule quoted in a question, never bounds the frame.
  let top = -1;
  let bounded = false;
  // Every row of the frame counts, the options and hint too, not only the
  // rows above them (Codex P2).
  let widest = 0;
  for (let i = blockTop; i <= hintIdx && i < lines.length; i += 1) widest = Math.max(widest, colOf(lines, i));
  for (let i = blockTop - 1; i >= 0 && i >= blockTop - 24; i -= 1) {
    const len = colOf(lines, i);
    // The frame's rule spans the terminal: as wide as the WHOLE screen's
    // widest row, not just the rows under it (a 60-column rule quoted above
    // short rows is not one: Codex P2).
    if (/^─/.test(lines[i]) && SCREEN_RULE_RE.test(lines[i].trim()) && len >= widest && len >= frameW) { bounded = true; break; }
    widest = Math.max(widest, len);
    if (i === 0) bounded = true;
    if (lines[i].trim()) top = i;
  }
  if (!bounded || top === -1 || !/[☐☒]/.test(lines[top]) || !isTabBar(lines[top])) return null;
  const tb = top;
  // A bare tab (no arrows) is Claude's single-question header, and all of it
  // is the label: a header "Use ☐ box" is not two questions (Codex P2).
  if (!/^\s*←/.test(lines[tb])) {
    const label = lines[tb].trim().replace(/^[☐☒]\s*/, '').slice(0, 60);
    return label ? { labels: [label], answered: [lines[tb].trim().startsWith('☒')], current: 0, total: 1 } : null;
  }
  // Claude separates tabs by two or more spaces (`←  ☐ Color  ☐ Size  ✔
  // Submit  →`); a header may hold single-spaced marks of its own ("Use ☐
  // box", "✔ Check"), so items are the 2+-space runs, never every mark
  // (Codex P2, three rounds). Runs of non-space joined by single spaces:
  // linear, the two parts cannot overlap.
  const items = [];
  const row = lines[tb];
  const runs = [...row.matchAll(/\S+(?: \S+)*/g)];
  // Only the bar's own ends are navigation: an arrow anywhere else is header
  // text ("Deploy  →" is a header, Codex P2).
  if (runs[0]?.[0] === '←') runs.shift();
  if (runs[runs.length - 1]?.[0] === '→') runs.pop();
  for (const m of runs) {
    const run = m[0];
    const prev = items[items.length - 1];
    // A run with no mark of its own continues the header before it: "Deploy
    // prod" with two spaces is one header, not "Deploy" (Codex P2).
    if (!/^[☐☒✔]/.test(run)) { if (prev) prev.label = row.slice(prev.col + 1, m.index + run.length).trim().slice(0, 60); continue; }
    items.push({ mark: run[0], label: run.slice(1).trim().slice(0, 60), col: m.index });
  }
  // Only the LAST ✔ run is the review step.
  for (let k = items.length - 2; k >= 0; k -= 1) if (items[k].mark === '✔') items.splice(k, 1);
  for (let k = items.length - 1; k >= 0; k -= 1) if (items[k].mark !== '✔' && !items[k].label) items.splice(k, 1);
  const questions = items.filter((t) => t.mark !== '✔');
  if (!questions.length) return null;
  const labels = questions.map((t) => t.label);
  const answered = questions.map((t) => t.mark === '☒');
  const total = labels.length;
  let current = -1;
  // The highlighted run is matched to a tab by POSITION (labels can repeat,
  // a question can be named "Submit"); the ✔ item is the review step.
  const hl = lines.highlights?.[tb];
  if (Array.isArray(hl)) {
    for (const h of hl) {
      if (!h || typeof h.col !== 'number') continue;
      const end = h.col + String(h.text).length;
      const hit = items.find((t) => t.col >= h.col - 1 && t.col < end);
      if (!hit) continue;
      current = hit.mark === '✔' ? total : questions.indexOf(hit);
      break;
    }
  }
  if (current === -1) {
    const open = answered.indexOf(false);
    current = open === -1 ? total : open;
  }
  return { labels, answered, current, total };
}

/**
 * The question above a selector block, ALL of it: a permission prompt draws
 * the tool and its command above "Do you want to proceed?", and a long
 * question wraps over several rows. Taking only the nearest row cut both
 * (Sam: "the interactive messages sometimes get cutoff"). Rows run from the
 * rule or tab bar the prompt is drawn under; with neither close above, only
 * the paragraph touching the block, so transcript prose is never swept in.
 */
const PROMPT_MAX_ROWS = 15;
const SCREEN_CONTEXT_ROWS = 40;
const PROMPT_MAX_CHARS = 1500;
/**
 * Rows Claude wrapped, back into one line. Claude's TUI breaks a row only at
 * a space, and only when the next word would not fit, so WIDTH tells a wrap
 * from a real newline: a row ending near the frame's edge whose successor's
 * first word could not have fit was wrapped, and gets its space back. A
 * shorter row ended on purpose (two command rows, `echo cleanup` + `rm -rf
 * build`, must stay two), and a row filling the whole width was cut
 * mid-word by the terminal: both keep the break. Guessing from the words
 * instead lost seven Codex rounds. The path/dot checks are a second guard
 * that only ever keeps a break.
 */
const WRAP_SLACK = 4; // the TUI may wrap a few columns inside the frame's edge
// A wrapped row also REACHES near the edge: a short row followed by a long
// word is an intentional newline as often as a wrap, and joining it could
// hide a second command (Codex P2). Ambiguous rows keep their break.
const WRAP_REACH = 10;
function reflow(rows, ends, frameW) {
  let out = '';
  rows.forEach((r, k) => {
    if (!k) { out = r; return; }
    const end = ends?.[k - 1];
    const line = out.slice(out.lastIndexOf('\n') + 1);
    const wrapped = r !== '' && !SCREEN_RULE_RE.test(r) && typeof end === 'number' && frameW > 0 && end < frameW && end >= frameW - WRAP_REACH
      && end + 1 + rowWidth(r.split(' ')[0]) > frameW - WRAP_SLACK;
    const dotted = (w) => /\.\w/.test(w);
    const pathy = line.includes('/') || r.includes('/') || dotted(line.split(' ').pop()) || dotted(r.split(' ')[0]) || !line.includes(' ');
    out += wrapped && !pathy ? ` ${r}` : `\n${r}`;
  });
  return out;
}

function screenPrompt(lines, blockTop, prose = false, frameW = 0) {
  const paragraphs = [[]]; // rows as { t, end }: the text and the column it ends at
  let bounded = false;
  for (let i = blockTop - 1; i >= 0 && i >= blockTop - 30; i -= 1) {
    const t = lines[i].trim();
    if (SCREEN_RULE_RE.test(t) || SCREEN_CHROME_RE.test(t)) { bounded = true; break; }
    if (!t) { if (paragraphs[0].length) paragraphs.unshift([]); continue; }
    // A lone glyph or border is not shown, but it still separated what is
    // around it: a paragraph break, never something reflow joins across
    // (`***` between two commands, Codex P2).
    if (!/[\p{L}\p{N}]/u.test(t)) { if (paragraphs[0].length) paragraphs.unshift([]); continue; }
    const row = { t, end: colOf(lines, i) };
    paragraphs[0].unshift(row);
  }
  const kept = (bounded ? paragraphs : paragraphs.slice(-1)).filter((p) => p.length);
  if (prose) {
    let text = kept.map((p) => reflow(p.map((x) => x.t), p.map((x) => x.end), frameW)).join('\n');
    if (text.length > PROMPT_MAX_CHARS) text = text.slice(-PROMPT_MAX_CHARS);
    return text;
  }
  let rows = kept.flat().map((x) => x.t);
  if (rows.length > PROMPT_MAX_ROWS) rows = rows.slice(-PROMPT_MAX_ROWS); // the question sits last
  let text = rows.join('\n');
  if (text.length > PROMPT_MAX_CHARS) text = text.slice(-PROMPT_MAX_CHARS);
  return text;
}

/**
 * What a selector card shows: the question and its numbered options, not
 * which option the cursor is on (arrow keys move that without changing the
 * prompt). '' for no selector.
 */
export function selectorFingerprint(sel) {
  if (!sel || !Array.isArray(sel.options)) return '';
  const opts = sel.options.map((o) => `${o?.num}.${o?.label}\n${o?.detail || ''}`);
  // context: the raw rows above the options (non-enumerable, never sent to a
  // client). Two Bash prompts both read "Do you want to proceed?" with the
  // same labels; the command above them is what tells them apart.
  return createHash('sha1').update(JSON.stringify([sel.prompt || '', opts, sel.context || ''])).digest('hex').slice(0, 16);
}

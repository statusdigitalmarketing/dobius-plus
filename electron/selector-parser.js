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
  for (let i = hintIdx - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || SCREEN_RULE_RE.test(t)) continue;
    const m = line.match(SCREEN_OPTION_RE);
    if (m) {
      const opt = { num: Number(m[2]), label: m[3].trim() };
      if (pendingDetail.length) opt.detail = pendingDetail.reverse().join('\n');
      pendingDetail = [];
      options.unshift(opt);
      blockTop = i;
      continue;
    }
    // Non-numbered line: a description under an option (indented) keeps the
    // walk going while we are inside the block; anything else above the
    // topmost option ends the block.
    if (/^\s{3,}\S/.test(line)) { pendingDetail.push(t); continue; } // option description
    if (options.length === 0) { pendingDetail = []; continue; } // hint chrome between hint and block
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

  const steps = screenSteps(lines, blockTop);
  // An AskUserQuestion question is prose that Claude wrapped at the terminal
  // width: re-flow its rows into one paragraph, or a phone card shows it
  // broken mid-sentence. Permission prompts and the review step keep their
  // rows (a command, its description, the question; answers one per line).
  const prose = !!steps && steps.current < steps.total;
  // Option descriptions likewise (Claude wrapped them at the terminal width).
  const opts = prose ? options.map((o) => (o.detail ? { ...o, detail: reflow(o.detail.split('\n')) } : o)) : options;
  const out = { prompt: screenPrompt(lines, blockTop, prose), options: opts, selectedIndex: sel };
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
const TAB_ITEM_RE = /([☐☒✔])\s*([^☐☒✔←→]*?)\s*(?=[☐☒✔→]|$)/g;
// A tab bar row holds NOTHING but tab items (and the ← → arrows): a line of
// prose with checkboxes in it ("Todo: ☐ Cleanup ☐ Verify") is not one
// (Codex). A plain linear test: a regex here backtracked exponentially on a
// crafted row and froze the main process (Codex P1).
function isTabBar(line) {
  const t = line.trim().replace(/^←\s*/, '').replace(/\s*→$/, '');
  return /^[☐☒✔]/.test(t) && !/[←→]/.test(t);
}
function screenSteps(lines, blockTop) {
  // The tab bar sits between the frame's rule and the question: never look
  // past a rule (a permission prompt's border), so text above it can't count.
  // A multi-question bar is drawn between arrows (`← ... →`); a question
  // line that merely STARTS with a checkbox ("☐ means disabled...") also
  // passes isTabBar, so an arrow-led row above it wins (Codex P2). With no
  // arrow-led row (a single question's bare tab), the nearest one stands.
  let tb = -1;
  for (let i = blockTop - 1; i >= 0 && i >= blockTop - 24; i -= 1) {
    if (SCREEN_RULE_RE.test(lines[i].trim())) break;
    if (!/[☐☒]/.test(lines[i]) || !isTabBar(lines[i])) continue;
    if (/^\s*←/.test(lines[i])) { tb = i; break; }
    if (tb === -1) tb = i;
  }
  if (tb === -1) return null;
  const items = [];
  for (const m of lines[tb].matchAll(TAB_ITEM_RE)) {
    if (m[1] !== '✔' && !m[2]) continue;
    items.push({ mark: m[1], label: m[2].slice(0, 60), col: m.index });
  }
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
 * Rows Claude wrapped, back into one line with spaces. Where the break may
 * have fallen inside a token (the row's last word holds a '/', or the row is
 * one unbroken token that filled it), neither a space nor no space is safe
 * to guess (`/srv/confi` + `g.json` vs `/tmp/cache/x` + `after`): the
 * terminal's own line break is kept, so the card shows exactly what the
 * terminal did and never a different path (Codex, three rounds).
 */
function reflow(rows) {
  let out = '';
  for (const r of rows) {
    if (!out) { out = r; continue; }
    const line = out.slice(out.lastIndexOf('\n') + 1);
    const last = line.split(' ').pop();
    out += last.includes('/') || !line.includes(' ') ? `\n${r}` : ` ${r}`;
  }
  return out;
}

function screenPrompt(lines, blockTop, prose = false) {
  const paragraphs = [[]];
  let bounded = false;
  for (let i = blockTop - 1; i >= 0 && i >= blockTop - 30; i -= 1) {
    const t = lines[i].trim();
    if (SCREEN_RULE_RE.test(t) || SCREEN_CHROME_RE.test(t)) { bounded = true; break; }
    if (!t) { if (paragraphs[0].length) paragraphs.unshift([]); continue; }
    if (!/[\p{L}\p{N}]/u.test(t)) continue; // a lone glyph or border
    paragraphs[0].unshift(t);
  }
  const kept = (bounded ? paragraphs : paragraphs.slice(-1)).filter((p) => p.length);
  if (prose) {
    let text = kept.map((p) => reflow(p)).join('\n');
    if (text.length > PROMPT_MAX_CHARS) text = text.slice(-PROMPT_MAX_CHARS);
    return text;
  }
  let rows = kept.flat();
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

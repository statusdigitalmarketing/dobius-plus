// A `! command` line Claude hands back is its own box with its own Copy (Sam, 2026-11-13: "the commands that come
// after the exclamation point aren't copyable ... it only allows me to copy the whole message"). Rendered through a
// fenced block with its own language so markdown keeps everything around it as it was.
//
// Copy puts the text into a shell, so a box is made only when the line holds exactly one command and markdown would
// read it as plain paragraph text (Codex, PR 10, two rounds). Anything doubtful is left as the reply wrote it:
//   - one line, at column 0: `! cmd`, or `` `! cmd` `` with the closing backtick ending the line. No backtick inside
//     the command, nothing a card could hide (shared/handoff.js), no trailing `\` (joining lines changes what runs).
//   - its paragraph is a plain one: not inside a quote or a list (a column-0 line there is a lazy continuation of
//     it), not a table, not a heading (a `===` or `---` underline anywhere below in the paragraph), and no inline
//     code span crosses into or out of the line.
//   - never inside a code fence (closed only by the same character, at least as long, nothing after it) or a raw
//     HTML block that spans blank lines (comments, <pre>, <script>, <style>, <textarea>, <? ?>, <! >, CDATA).
// Splitting a plain paragraph ("Run this:\n! cmd") keeps every word and its order, which is the point.
import { HIDDEN_CMD_RE } from '../shared/handoff.js';

export const CMD_LANG = 'dobius-cmd';
const PLAIN_RE = /^! ([^`]*[^`\s\\])[ \t]*$/;
const TICKED_RE = /^`! ([^`]*[^`\s\\])`[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_DELIM_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// CommonMark HTML blocks 1 to 5: they run until their end marker, across blank lines.
const HTML_BLOCKS = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?:[\s>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];

function commandOf(line) {
  const m = TICKED_RE.exec(line) || PLAIN_RE.exec(line);
  if (!m) return null;
  const cmd = m[1].trim();
  if (!cmd || HIDDEN_CMD_RE.test(cmd)) return null;
  if (typeof cmd.isWellFormed !== 'function' || !cmd.isWellFormed()) return null;
  return cmd;
}

// Inline code spans of a paragraph (CommonMark: a run of N backticks closes at the next run of exactly N), as
// [start, end) offsets into `text`. Linear: one forward-only pointer per run length, so a reply full of unmatched
// backticks cannot stall the phone.
function codeSpans(text) {
  const runs = [];
  for (const m of text.matchAll(/`+/g)) runs.push([m.index, m[0].length]);
  const byLen = new Map(); // length -> indexes into runs, in order
  runs.forEach(([, n], k) => { if (!byLen.has(n)) byLen.set(n, []); byLen.get(n).push(k); });
  const ptr = new Map(); // length -> position in byLen list
  const spans = [];
  let pos = 0;
  for (let k = 0; k < runs.length; k += 1) {
    const [at, n] = runs[k];
    if (at < pos) continue; // inside a span already found
    const list = byLen.get(n);
    let j = ptr.get(n) || 0;
    while (j < list.length && list[j] <= k) j += 1;
    ptr.set(n, j);
    if (j < list.length) {
      const [cAt] = runs[list[j]];
      spans.push([at, cAt + n]);
      pos = cAt + n;
    }
  }
  return spans;
}

export function withCommandBlocks(text) {
  if (typeof text !== 'string' || !text.includes('! ')) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null; // { ch, len } inside a fenced code block
  let html = null; // the end marker of a raw HTML block
  let para = null; // the paragraph run the current line is in: { start, end, nested, table, heading, spans, offsets }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (new RegExp(`^ {0,3}\\${fence.ch}{${fence.len},}\\s*$`).test(line)) fence = null;
      out.push(line);
      continue;
    }
    if (html) {
      if (html.test(line)) html = null;
      out.push(line);
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) { fence = { ch: open[1][0], len: open[1].length }; para = null; out.push(line); continue; }
    const block = HTML_BLOCKS.find(([start]) => start.test(line));
    if (block) { if (!block[1].test(line)) html = block[1]; para = null; out.push(line); continue; }
    if (!line.trim()) { para = null; out.push(line); continue; }
    if (!para) para = paragraphAt(lines, i);
    if (QUOTE_RE.test(line) || LIST_RE.test(line)) para.nested = true; // the rest of this run belongs to it
    const cmd = para.nested || para.table || para.heading ? null : commandOf(line);
    if (!cmd || crossesSpan(para, i)) { out.push(line); continue; }
    out.push('', `\`\`\`${CMD_LANG}`, cmd, '```', '');
  }
  return out.join('\n');
}

// The run of non-blank lines from `start` (stopping at a fence or HTML block), and what kind of paragraph it is.
function paragraphAt(lines, start) {
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].trim() && !FENCE_OPEN_RE.test(lines[end + 1]) && !HTML_BLOCKS.some(([s]) => s.test(lines[end + 1]))) end += 1;
  const run = lines.slice(start, end + 1);
  const offsets = [];
  let at = 0;
  for (const l of run) { offsets.push(at); at += l.length + 1; }
  return {
    start,
    nested: false,
    table: run.some((l, k) => k > 0 && run[k - 1].includes('|') && l.includes('-') && TABLE_DELIM_RE.test(l)),
    heading: run.some((l, k) => k > 0 && SETEXT_RE.test(l)),
    spans: codeSpans(run.join('\n')),
    offsets,
    lens: run.map((l) => l.length),
  };
}

// Whether an inline code span reaches into the line from outside it, or out of it.
function crossesSpan(para, i) {
  const k = i - para.start;
  const from = para.offsets[k];
  const to = from + para.lens[k];
  return para.spans.some(([a, b]) => a < to && b > from && (a < from || b > to));
}

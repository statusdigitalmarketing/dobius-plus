// A `! command` line Claude hands back is its own box with its own Copy (Sam, 2026-11-13: "the commands that come
// after the exclamation point aren't copyable ... it only allows me to copy the whole message").
//
// A remark plugin, so markdown itself decides the structure (three Codex rounds on PR 10 broke every text-level
// guess: fences, tables, quotes, lists, headings, code spans, links, emphasis). It only splits a top-level paragraph
// at a line that, in the parsed tree, stands alone and reads exactly as written:
//   - the paragraph is a direct child of the document (never in a quote, list, table or heading), and no inline
//     element in it spans a line break (a multi-line link, emphasis or code span leaves the paragraph untouched);
//   - the source line is `! cmd` or `` `! cmd` `` at column 0, and what markdown shows for it is that same text
//     (no escapes, entities, emphasis or links changed it; a bare URL autolink is fine);
//   - the command has no backtick, no trailing `\` (joining lines changes what runs), nothing a card could hide
//     (shared/handoff.js) and is well-formed UTF-16.
// The box is a `dobius-cmd` element, which a reply cannot produce itself (raw HTML is not rendered), so a reply's own
// code block can never be mistaken for one.
import { HIDDEN_CMD_RE } from '../shared/handoff.js';

export const CMD_TAG = 'dobius-cmd';
const PLAIN_RE = /^! ([^`]*[^`\s\\])[ \t]*$/;
const TICKED_RE = /^`! ([^`]*[^`\s\\])`[ \t]*$/;

function commandOf(cmd) {
  if (!cmd || HIDDEN_CMD_RE.test(cmd)) return null;
  if (typeof cmd.isWellFormed !== 'function' || !cmd.isWellFormed()) return null;
  return cmd;
}

const text = (value) => ({ type: 'text', value });
const oneLine = (n) => !n.position || n.position.start.line === n.position.end.line;

// What markdown shows for one line of a paragraph, or null when a part of it is not plain text: only text, a bare
// URL autolink (its text equals its source) and, alone on the line, inline code.
function shown(parts, source) {
  if (parts.length === 1 && parts[0].type === 'inlineCode') return `\`${parts[0].value}\``;
  let out = '';
  for (const n of parts) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'link' && n.children.length === 1 && n.children[0].type === 'text' && n.position
      && source.slice(n.position.start.offset, n.position.end.offset) === n.children[0].value) out += n.children[0].value;
    else return null;
  }
  return out;
}

function splitParagraph(p, source, srcLines) {
  if (!p.position || !p.children.every((n) => n.type === 'text' || n.type === 'break' || oneLine(n))) return [p];
  // The paragraph's lines, each a list of inline nodes (text split at its line breaks).
  const lines = [[]];
  for (const n of p.children) {
    if (n.type === 'text') {
      n.value.split(/\r\n?|\n/).forEach((t, k) => { if (k > 0) lines.push([]); if (t) lines[lines.length - 1].push(text(t)); });
    } else if (n.type === 'break') {
      lines[lines.length - 1].push(n);
      lines.push([]);
    } else lines[lines.length - 1].push(n);
  }
  const first = p.position.start.line;
  const cmdAt = lines.map((parts, k) => {
    const src = (srcLines[first - 1 + k] || '').replace(/[ \t]+$/, '');
    const m = TICKED_RE.exec(src) || PLAIN_RE.exec(src);
    if (!m || shown(parts, source)?.replace(/[ \t]+$/, '') !== src) return null;
    return commandOf(m[1].replace(/^ +/, '')); // ASCII spaces only: trim() would drop a U+00A0 or U+FEFF unchecked
  });
  if (!cmdAt.some(Boolean)) return [p];
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push({ type: 'paragraph', children: run }); run = []; };
  lines.forEach((parts, k) => {
    if (cmdAt[k]) {
      flush();
      out.push({ type: 'dobiusCmd', data: { hName: CMD_TAG }, children: [text(cmdAt[k])] });
      return;
    }
    if (run.length && run[run.length - 1].type !== 'break') run.push(text('\n'));
    run.push(...parts);
  });
  flush();
  return out;
}

/** remark plugin: lift each standalone `! command` line of a top-level paragraph into a `dobius-cmd` element. */
export function remarkCommandBoxes() {
  return (tree, file) => {
    const source = String(file.value ?? '');
    if (!source.includes('! ')) return;
    const srcLines = source.split(/\r\n?|\n/);
    tree.children = tree.children.flatMap((n) => (n.type === 'paragraph' ? splitParagraph(n, source, srcLines) : [n]));
  };
}

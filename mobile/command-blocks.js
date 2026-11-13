// A `! command` line Claude hands back is its own box with its own Copy (Sam, 2026-11-13: "the commands that come
// after the exclamation point aren't copyable ... it only allows me to copy the whole message"). Rendered through a
// fenced block with its own language so markdown keeps everything around it as it was.
//
// Copy puts the text into a shell, so a box is made only when the line holds exactly one command and nothing else
// (Codex, PR 10). Anything doubtful is left as the reply wrote it:
//   - one line only, starting at column 0: `! cmd` or `` `! cmd` `` with the closing backtick ending the line and no
//     other backtick. A line ending in `\` (shell continuation) is left alone: joining lines changes what runs.
//   - never inside a code fence (closed only by the same character, at least as long, nothing after it), a table
//     (from its delimiter row to the next blank line), or when the next line turns it into a heading (=== or ---).
//   - nothing a card could hide (shared/handoff.js HIDDEN_CMD_RE) and well-formed UTF-16.
import { HIDDEN_CMD_RE } from '../shared/handoff.js';

export const CMD_LANG = 'dobius-cmd';
const PLAIN_RE = /^! (\S.*)$/;
const TICKED_RE = /^`! ([^`]*\S)`[ \t]*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_DELIM_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;

function commandOf(line) {
  const m = TICKED_RE.exec(line) || PLAIN_RE.exec(line);
  if (!m) return null;
  const cmd = m[1].trim();
  if (!cmd || /\\$/.test(cmd) || cmd.includes('```') || HIDDEN_CMD_RE.test(cmd)) return null;
  if (typeof cmd.isWellFormed !== 'function' || !cmd.isWellFormed()) return null;
  return cmd;
}

export function withCommandBlocks(text) {
  if (typeof text !== 'string' || !text.includes('! ')) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null; // { ch, len } while inside a fenced code block
  let table = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      const close = new RegExp(`^ {0,3}(\\${fence.ch}{${fence.len},})\\s*$`).exec(line);
      if (close) fence = null;
      out.push(line);
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      out.push(line);
      continue;
    }
    if (!line.trim()) table = false;
    else if (!table && i > 0 && lines[i - 1].includes('|') && line.includes('-') && TABLE_DELIM_RE.test(line)) table = true;
    const cmd = table ? null : commandOf(line);
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    const heading = SETEXT_RE.test(next);
    const tableHead = line.includes('|') && next.includes('-') && TABLE_DELIM_RE.test(next);
    if (!cmd || heading || tableHead) { out.push(line); continue; }
    out.push('', `\`\`\`${CMD_LANG}`, cmd, '```', '');
  }
  return out.join('\n');
}

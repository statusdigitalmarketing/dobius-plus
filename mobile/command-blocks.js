// A `! command` line Claude hands back is its own box with its own Copy (Sam, 2026-11-13: "the commands that come
// after the exclamation point aren't copyable ... it only allows me to copy the whole message"). The same lines
// Tasks > Commands picks up (a plain or backticked `! ` line, ` \` continuing it), outside code fences; a line in a
// list keeps its place in the list and is left alone. Rendered through a fenced block with its own language so
// markdown keeps everything around it as it was.
export const CMD_LANG = 'dobius-cmd';
const CMD_LINE_RE = /^[ ]{0,3}(`?)! (\S.*)$/;
export function withCommandBlocks(text) {
  if (typeof text !== 'string' || !text.includes('! ')) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.push(line);
      continue;
    }
    const m = fence ? null : CMD_LINE_RE.exec(line);
    if (!m) { out.push(line); continue; }
    let cmd = m[2];
    if (m[1] === '`') cmd = cmd.replace(/`\s*$/, '');
    let j = i;
    while (/(^|[^\\])\\\s*$/.test(cmd) && j + 1 < lines.length) {
      j += 1;
      cmd = `${cmd.replace(/\\\s*$/, '').trimEnd()} ${lines[j].trim()}`;
    }
    cmd = cmd.trim();
    if (!cmd || cmd.includes('```')) { out.push(line); continue; }
    i = j;
    out.push('', `\`\`\`${CMD_LANG}`, cmd, '```', '');
  }
  return out.join('\n');
}

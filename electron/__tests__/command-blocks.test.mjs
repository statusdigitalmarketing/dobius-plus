// Phone chat: each handed-back `! command` line becomes its own box with its own Copy (mobile/command-blocks.js).
// Copy goes into a shell, so anything doubtful must be left exactly as the reply wrote it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCommandBlocks, CMD_LANG } from '../../mobile/command-blocks.js';

const box = (cmd) => ['', `\`\`\`${CMD_LANG}`, cmd, '```', ''].join('\n');
const same = (s) => assert.equal(withCommandBlocks(s), s);

test('a plain and a backticked ! line each become a command block', () => {
  assert.equal(withCommandBlocks('Run this:\n! open -a "Dobius+"\nthen done'), `Run this:\n${box('open -a "Dobius+"')}\nthen done`);
  assert.equal(withCommandBlocks('`! gh run cancel 123`'), box('gh run cancel 123'));
  assert.equal(withCommandBlocks('! a\r\n! b'), `${box('a')}\n${box('b')}`);
});

test('left alone: lists, indented, prose with a bang, empty, inline fence', () => {
  for (const s of ['- ! listed cmd', '  ! indented cmd', 'Wow! nice', '!  ', '! has ``` fence', '', '`! no closing tick', '`! a` and more', '`! a `b` c`']) same(s);
  assert.equal(withCommandBlocks(null), null);
});

test('fences: inside stays, a shorter or different run does not close (Codex P2)', () => {
  same('```sh\n! not this\n```');
  same('~~~\n! nor this\n~~~');
  same('````sh\n```\n! echo ok\n````');
  same('~~~\n```\n! echo ok\n~~~');
  same('```\n``` not a close\n! echo ok\n```');
  assert.equal(withCommandBlocks('````sh\n```\n````\n! echo ok'), `\`\`\`\`sh\n\`\`\`\n\`\`\`\`\n${box('echo ok')}`);
});

test('tables: a row or a header is never lifted (Codex P2)', () => {
  same('Command | Purpose\n--- | ---\n! echo ok | Print greeting');
  same('! echo ok | x\n--- | ---\na | b');
  assert.equal(withCommandBlocks('a | b\n--- | ---\nc | d\n\n! echo ok'), `a | b\n--- | ---\nc | d\n\n${box('echo ok')}`);
});

test('a line continued with a backslash is left alone (Codex P2 x3)', () => {
  same('`! echo ok \\`\nDo not run this on production.');
  same('`! printf \\\n  "%s" ok`');
  same('! printf "%s" "a\\\nb"');
  same('! git push \\\n  origin main');
});

test('hidden characters and setext headings are left alone (Codex P2)', () => {
  same('! git\u200b status');
  same('! echo\u202e ok');
  same('! echo \ud800 ok');
  same('! echo ok\n---');
  same('! echo ok\n===');
});

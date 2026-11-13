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

test('the usual handback shape is boxed: a line of prose, then the command (shared/handoff.js example)', () => {
  assert.equal(withCommandBlocks('Run this yourself:\n! echo dobius-bang-test'), `Run this yourself:\n${box('echo dobius-bang-test')}`);
  assert.equal(withCommandBlocks('Run `make` first, then:\n! npm test'), `Run \`make\` first, then:\n${box('npm test')}`);
});

test('a multiline inline code span is left alone (Codex P2, round 2)', () => {
  same('`example\n! echo ok\nend`');
  same('``a\n! echo ok\nb``');
});

test('a lazy continuation of a quote or list item is left alone (Codex P2, round 2)', () => {
  same('> Do not run:\n! rm -rf /');
  same('- Do not run:\n! rm -rf /');
  same('1. Do not run:\n! rm -rf /');
  same('Intro\n> quoted\n! rm -rf /');
  assert.equal(withCommandBlocks('> quoted\n\n! echo ok'), `> quoted\n\n${box('echo ok')}`);
});

test('a line in a paragraph that ends as a setext heading is left alone (Codex P2, round 2)', () => {
  same('! echo ok\nThis is a heading\n===');
  same('! echo ok\nmore\n---');
});

test('a backtick anywhere in the command, or an extra one, is left alone (Codex P2, round 2)', () => {
  same('`! echo ok``');
  same('! echo `date`');
  same('! echo ok`');
});

test('raw HTML blocks that hide their contents are left alone', () => {
  same('<!--\n\n! rm -rf /\n\n-->');
  same('<pre>\n\n! rm -rf /\n\n</pre>');
  assert.equal(withCommandBlocks('<!-- note -->\n\n! echo ok'), `<!-- note -->\n\n${box('echo ok')}`);
});

test('a reply full of unmatched backtick runs stays fast', () => {
  // 700 unmatched runs of different lengths, then 20000 short ones: a scan that looks ahead from every opener for
  // its closer is 14 million steps (about 300 ms on an M-series Mac, seconds on a phone); the linear one is a few ms.
  let s = 'Intro ';
  for (let n = 100; n < 800; n++) s += '`'.repeat(n) + ' x ';
  for (let i = 0; i < 20000; i++) s += '` ';
  s += '\n! echo ok';
  const t0 = performance.now();
  withCommandBlocks(s);
  assert.ok(performance.now() - t0 < 60, `took ${performance.now() - t0} ms`);
});

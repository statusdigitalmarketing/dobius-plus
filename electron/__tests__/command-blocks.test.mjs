// Phone chat: each handed-back `! command` line becomes its own box with its own Copy (mobile/command-blocks.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCommandBlocks, CMD_LANG } from '../../mobile/command-blocks.js';

const box = (cmd) => ['', `\`\`\`${CMD_LANG}`, cmd, '```', ''].join('\n');

test('a plain and a backticked ! line each become a command block', () => {
  assert.equal(withCommandBlocks('Run this:\n! open -a "Dobius+"\nthen done'), `Run this:\n${box('open -a "Dobius+"')}\nthen done`);
  assert.equal(withCommandBlocks('`! gh run cancel 123`'), box('gh run cancel 123'));
});

test('a trailing backslash continues the command', () => {
  assert.equal(withCommandBlocks('! git push \\\n  origin main'), box('git push origin main'));
});

test('left alone: inside fences, in a list, prose with a bang, no command', () => {
  const fenced = '```sh\n! not this\n```\n~~~\n! nor this\n~~~';
  assert.equal(withCommandBlocks(fenced), fenced);
  assert.equal(withCommandBlocks('- ! listed cmd'), '- ! listed cmd');
  assert.equal(withCommandBlocks('Wow! nice'), 'Wow! nice');
  assert.equal(withCommandBlocks('!  '), '!  ');
  assert.equal(withCommandBlocks('! has ``` fence'), '! has ``` fence');
  assert.equal(withCommandBlocks(''), '');
  assert.equal(withCommandBlocks(null), null);
});

test('CRLF text and several commands', () => {
  assert.equal(withCommandBlocks('! a\r\n! b'), `${box('a')}\n${box('b')}`);
});

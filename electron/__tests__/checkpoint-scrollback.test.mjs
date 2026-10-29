// Checkpoint scrollback: what is drawn on a terminal's screen can carry no
// control character (a lone C1 CSI still drives xterm), and a fork's
// scrollback reaches the new tab once.
// Run: node ./electron/__tests__/checkpoint-scrollback.test.mjs
import assert from 'node:assert/strict';
import { drawableLine, setPendingScrollback, takePendingScrollback } from '../../src/lib/pending-scrollback.js';

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

assert.equal(drawableLine('ok \u009b2J\u009bH\u009b6n done'), 'ok 2JH6n done'); ok('C1 CSI cannot clear the screen or ask for a reply');
assert.equal(drawableLine('a\x1b[31mb\x07c\u009d0;x\u009cd'), 'a[31mbc0;xd'); ok('ESC, BEL, C1 OSC and ST are stripped');
assert.equal(drawableLine('line\r\nnext\b'), 'linenext'); ok('CR, LF and backspace are stripped');
assert.equal(drawableLine('tab\there café ✓ 漢'), 'tab here café ✓ 漢'); ok('tabs become spaces, real text is kept');
assert.equal(drawableLine(42), '42'); ok('non-strings are stringified');

setPendingScrollback('term-/p-1', { scrollback: ['x'] });
assert.deepEqual(takePendingScrollback('term-/p-1'), { scrollback: ['x'] });
assert.equal(takePendingScrollback('term-/p-1'), undefined); ok('a fork hands its scrollback over once');
assert.equal(takePendingScrollback('term-/p-2'), undefined); ok('another tab gets nothing');

console.log(`checkpoint-scrollback: ${pass} pass`);

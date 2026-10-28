// Terminal-generated replies must not count as input (they would mark the
// Chat selector stale on every focus change); real keys must.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalReply } from '../terminal-reply.js';

test('emulator replies are recognized', () => {
  for (const s of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?2026;2$y',
    '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b]10;rgb:ffff/ffff/ffff\x07', '\x1b[I\x1b[O']) {
    assert.equal(isTerminalReply(s), true, JSON.stringify(s));
  }
});

test('anything a person types is input', () => {
  for (const s of ['1', '\r', '\x1b', '\x1b[A', '\x03', ' ', '\x1b[Ia', 'a\x1b[I', '\x1b[200~x\x1b[201~', '']) {
    assert.equal(isTerminalReply(s), false, JSON.stringify(s));
  }
});

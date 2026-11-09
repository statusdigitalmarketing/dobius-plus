// dobius-send into an existing tab (electron/tab-send.js), and the terminal replies that must never count as typing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendToTab } from '../tab-send.js';
import { stripTerminalReplies, isTerminalReply } from '../terminal-reply.js';
import { isKeyboardInput } from '../bridge-open-tab.js';

const RULE = '─'.repeat(40);
function screenWith(boxText, { dialog = false } = {}) {
  const lines = dialog
    ? ['previous output', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel']
    : ['previous output', RULE, `❯ ${boxText}`, RULE, '  ? for shortcuts'];
  lines.dimFrom = lines.map(() => -1);
  return { lines, modes: { bracketedPaste: true, cursor: { x: 2 + boxText.length, y: 2 } } };
}

function fakeTab({ leads, claude = true, working = false, box = '', dialog = false, enterInsertsNewline = false, keysAfterPaste = false } = {}) {
  let clock = 0;
  const t = { box, seq: 0, keys: 0, pasted: null, written: [], submitted: 0, pty: {}, alive: true };
  const deps = {
    tabAlive: () => t.alive,
    ptyOf: () => (t.alive ? t.pty : null),
    claudeRunning: async () => claude,
    claudeLeads: async () => (leads ?? claude),
    working: () => working,
    inputBusy: () => false,
    watch: () => ({ seq: () => t.seq, keys: () => t.keys, input: () => t.keys, screen: async () => screenWith(t.box, { dialog }), stop: () => {} }),
    paste: (_id, text) => {
      t.pasted = text;
      t.box = `[Pasted text #1 +${text.split('\n').length - 1} lines]`;
      t.seq += 1;
      if (keysAfterPaste) t.keys += 1;
    },
    submit: () => { t.submitted += 1; t.seq += 1; if (!enterInsertsNewline) t.box = ''; },
    write: (_id, data) => { t.written.push(data); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { t, deps };
}

const BRIEF = 'Line one of the brief.\nLine two.\n'.repeat(80); // ~2.5k chars, many lines, like the report

test('a long multi-line message to an idle Claude is pasted and its Enter is confirmed', async () => {
  const { t, deps } = fakeTab();
  const r = await sendToTab(deps, 'tab', BRIEF);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, sent: BRIEF.length, submitted: true, confirmed: true });
  assert.equal(t.pasted, BRIEF);
  assert.equal(t.submitted, 1);
  assert.deepEqual(t.written, [], 'nothing typed raw into Claude');
});

test('an Enter that only adds a line is reported as not sent, never ok', async () => {
  const { t, deps } = fakeTab({ enterInsertsNewline: true });
  const r = await sendToTab(deps, 'tab', 'hello\nthere');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.typed, true);
  assert.equal(r.body.submitted, false);
  assert.equal(t.submitted, 1);
});

test('Claude working: pasted, then Enter once the box shows it, reported unconfirmed', async () => {
  const { t, deps } = fakeTab({ working: true });
  const r = await sendToTab(deps, 'tab', BRIEF);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.confirmed, false);
  assert.equal(t.pasted, BRIEF);
  assert.equal(t.submitted, 1);
});

test('Claude working and someone types after the paste: no Enter', async () => {
  const { t, deps } = fakeTab({ working: true, keysAfterPaste: true });
  const r = await sendToTab(deps, 'tab', 'x');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.typed, true);
  assert.equal(t.submitted, 0);
});

test('a draft in Claude\'s box or a dialog on screen: nothing typed at all', async () => {
  for (const opts of [{ box: 'half a thought' }, { dialog: true }]) {
    const { t, deps } = fakeTab(opts);
    const r = await sendToTab(deps, 'tab', 'go');
    assert.equal(r.status, 409, JSON.stringify(opts));
    assert.equal(r.body.ok, false);
    assert.equal(t.pasted, null);
    assert.equal(t.submitted, 0);
    assert.deepEqual(t.written, []);
  }
});

test('not Claude (a shell): typed in chunks, then Enter as its own write after them', async () => {
  const { t, deps } = fakeTab({ claude: false });
  const r = await sendToTab(deps, 'tab', BRIEF);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.confirmed, false);
  assert.equal(t.written.join(''), BRIEF);
  assert.ok(t.written.every((c) => c.length <= 256));
  assert.equal(t.written.some((c) => c.includes('\r')), false, 'the Enter is never inside the typed text');
  assert.equal(t.submitted, 1);
});

test('Claude running a command that holds the terminal: refused, nothing typed raw', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.deepEqual(t.written, []);
  assert.equal(t.submitted, 0);
});

test('no such tab: 404, nothing written', async () => {
  const { t, deps } = fakeTab();
  t.alive = false;
  const r = await sendToTab(deps, 'tab', 'x');
  assert.equal(r.status, 404);
  assert.equal(t.submitted, 0);
});

test('terminal string replies (DECRQSS, XTVERSION, kitty graphics) and kitty/DSR/window reports are not typing', () => {
  for (const r of ['\x1bP1$r2 q\x1b\\', '\x1bP1$r0m\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\', '\x1b_Gi=1;OK\x1b\\', '\x1b[?0u', '\x1b[?997;1n', '\x1b[8;24;80t']) {
    assert.equal(stripTerminalReplies(r), '', JSON.stringify(r));
    assert.equal(isTerminalReply(r), true, JSON.stringify(r));
    assert.equal(isKeyboardInput(r), false, JSON.stringify(r));
  }
});

test('keys still count as typing', () => {
  for (const k of ['a', '\r', '\x03', '\x1b[A', '\x1b[2~', '\x1b[13;2u', '\x1bP', '\x1b[200~hi\x1b[201~']) {
    assert.equal(isKeyboardInput(k), true, JSON.stringify(k));
    assert.equal(isTerminalReply(k), false, JSON.stringify(k));
  }
});

// dobius-send into an existing tab (electron/tab-send.js), and the terminal replies that must never count as typing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendToTab } from '../tab-send.js';
import { stripTerminalReplies, isTerminalReply } from '../terminal-reply.js';
import { isKeyboardInput } from '../bridge-open-tab.js';
import { classifyFront } from '../bridge-open-main.js';

const RULE = '─'.repeat(40);
function screenWith(boxText, { dialog = false } = {}) {
  const lines = dialog
    ? ['previous output', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel']
    : ['previous output', RULE, `❯ ${boxText}`, RULE, '  ? for shortcuts'];
  lines.dimFrom = lines.map(() => -1);
  return { lines, modes: { bracketedPaste: true, cursor: { x: 2 + boxText.length, y: 2 } } };
}

const SHELL = (() => { const lines = ['user@Mac project % ']; lines.dimFrom = [-1]; return { lines, modes: { bracketedPaste: true, cursor: { x: 19, y: 0 } } }; })();

function fakeTab({ leads, claude = true, working = false, needs = false, box = '', dialog = false, enterInsertsNewline = false, keysAfterPaste = false, keysWhileTyping = false, probeFails = false, boxOnScreen = claude, readerAfterPaste = false, closeOnSubmit = false, wheelDuringRead = false, keysDuringProbe = false, inTab = claude, keysDuringPause = false, wheelBeforeRead = false, partialAfterSubmit = false, needsAfterPaste = false, spinAfterSubmit = false, shell = SHELL, front = 'shell', busyScreen = false } = {}) {
  let clock = 0;
  const t = { box, seq: 0, keys: 0, input: 0, pasted: null, written: [], submitted: 0, pty: {}, alive: true, reads: 0, stopped: false, probes: 0 };
  const deps = {
    tabAlive: () => t.alive,
    ptyOf: () => (t.alive ? t.pty : null),
    claudeRunning: async () => { if (wheelBeforeRead && (t.probes += 1) === 1) t.input += 1; return claude && !(readerAfterPaste && t.pasted !== null); },
    claudeInTab: async () => inTab,
    frontKind: async () => front,
    claudeLeads: async () => { if (keysDuringProbe) t.keys += 1; if (probeFails) throw new Error('pgrep timed out'); return leads ?? claude; },
    needs: () => needs || (needsAfterPaste && t.pasted !== null),
    working: () => working,
    inputBusy: () => false,
    watch: () => ({
      seq: () => t.seq, keys: () => t.keys, input: () => t.keys + t.input, stop: () => { t.stopped = true; },
      screen: async () => {
        if ((spinAfterSubmit && t.submitted) || busyScreen) t.seq += 1; // a frame arrives during every read
        const shown = boxOnScreen ? screenWith(t.box, { dialog }) : shell;
        // A wheel turn recalls an earlier prompt while this read renders the screen as it was.
        if (wheelDuringRead && (t.reads += 1) === 1) { t.input += 1; t.seq += 1; t.box = 'an earlier prompt'; }
        return shown;
      },
    }),
    paste: (_id, text) => {
      t.pasted = text;
      t.box = `[Pasted text #1 +${text.split('\n').length - 1} lines]`;
      t.seq += 1;
      if (keysAfterPaste) t.keys += 1;
    },
    submit: () => { t.submitted += 1; t.seq += 1; if (!enterInsertsNewline) t.box = ''; if (partialAfterSubmit) t.box = 'hel'; if (closeOnSubmit) { t.alive = false; t.box = ''; } },
    write: (_id, data) => { t.written.push(data); if (keysWhileTyping) t.keys += 1; },
    // A person typing during a pause is only seen while the watch is running.
    sleep: async (ms) => { clock += ms; await null; if (keysDuringPause && t.written.length && !t.stopped) t.keys += 1; },
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

test('Claude working: pasted, then Enter once the box shows it, confirmed queued', async () => {
  const { t, deps } = fakeTab({ working: true });
  const r = await sendToTab(deps, 'tab', BRIEF);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.confirmed, true, 'the box emptied: queued');
  assert.match(r.body.note, /queued/);
  assert.equal(t.pasted, BRIEF);
  assert.equal(t.submitted, 1);
});

test('Claude working and Enter only adds a line: reported not sent', async () => {
  const { t, deps } = fakeTab({ working: true, enterInsertsNewline: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.submitted, false);
  assert.equal(t.submitted, 1);
});

test('a permission prompt that opens after the paste: no Enter', async () => {
  const { t, deps } = fakeTab({ working: true, needsAfterPaste: true });
  const r = await sendToTab(deps, 'tab', 'x');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.typed, true);
  assert.equal(t.submitted, 0);
});

test('a red left over from a prompt already answered, with an empty prompt on screen: sent', async () => {
  const { t, deps } = fakeTab({ needs: true });
  const r = await sendToTab(deps, 'tab', 'x');
  assert.equal(r.body.ok, true);
  assert.equal(t.submitted, 1);
});

test('a spinner that never lets the screen hold still after the Enter: two empty reads in a row confirm it', async () => {
  const { t, deps } = fakeTab({ spinAfterSubmit: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.confirmed, true);
  assert.equal(t.submitted, 1);
});

test('a message ending in a backslash is refused for Claude (line continuation)', async () => {
  const { t, deps } = fakeTab();
  const r = await sendToTab(deps, 'tab', 'run this \\');
  assert.equal(r.status, 409);
  assert.equal(t.pasted, null);
});

test('process checks that fail: refused, never typed raw', async () => {
  const { t, deps } = fakeTab({ claude: false, probeFails: true });
  const r = await sendToTab(deps, 'tab', 'x');
  assert.equal(r.status, 409);
  assert.deepEqual(t.written, []);
});

test('two sends to one tab at once: the second is refused', async () => {
  const { t, deps } = fakeTab();
  const [a, b] = await Promise.all([sendToTab(deps, 'tab', 'first'), sendToTab(deps, 'tab', 'second')]);
  assert.equal(a.body.ok, true);
  assert.equal(b.status, 409);
  assert.equal(t.pasted, 'first');
});

test('a shell tab: someone typing during the pause stops the Enter', async () => {
  const { t, deps } = fakeTab({ claude: false, keysWhileTyping: true });
  const r = await sendToTab(deps, 'tab', 'echo hi');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.submitted, false);
  assert.equal(t.submitted, 0);
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
  for (const k of ['a', '\r', '\x03', '\x1b[A', '\x1b[2~', '\x1b[13;2u', '\x1bP', '\x1b[200~hi\x1b[201~', '\x1bPhello\r\x1b\\', '\x1bPhello\x1b\\', '\x1b_hi\x1b\\', '\x1bP1$r\x03\x1b\\', '\x1b_G\x15\x1b\\']) {
    assert.equal(isKeyboardInput(k), true, JSON.stringify(k));
    assert.equal(isTerminalReply(k), false, JSON.stringify(k));
  }
});

test('the process checks say not Claude but the screen shows Claude\'s prompt: refused, nothing typed raw', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: false, boxOnScreen: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.status, 409);
  assert.deepEqual(t.written, []);
  assert.equal(t.submitted, 0);
});

test('a command Claude starts that reads the terminal after the paste: no Enter', async () => {
  const { t, deps } = fakeTab({ readerAfterPaste: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.typed, true);
  assert.equal(t.submitted, 0);
});

test('the tab closes right after the Enter (its Ctrl+C empties the box): not reported sent', async () => {
  const { t, deps } = fakeTab({ closeOnSubmit: true, enterInsertsNewline: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.submitted, false);
  assert.equal(t.submitted, 1);
});

test('a wheel turn recalls a prompt while the screen is read: the old read does not count, nothing pasted', async () => {
  const { t, deps } = fakeTab({ wheelDuringRead: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.status, 409);
  assert.equal(t.pasted, null);
});

test('a shell tab: keys typed during the process checks stop the text before any of it goes out', async () => {
  const { t, deps } = fakeTab({ claude: false, keysDuringProbe: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.status, 409);
  assert.deepEqual(t.written, []);
});

test('a shell tab: keys typed during the pause before Enter are seen (the watch runs until the Enter)', async () => {
  const { t, deps } = fakeTab({ claude: false, keysDuringPause: true });
  const r = await sendToTab(deps, 'tab', 'echo hi');
  assert.equal(r.status, 409);
  assert.equal(r.body.submitted, false);
  assert.equal(t.submitted, 0);
});

test('process checks that time out into "no" while a claude process is in the tab: refused, nothing typed', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: false, boxOnScreen: false, inTab: true });
  const r = await sendToTab(deps, 'tab', '1');
  assert.equal(r.status, 409);
  assert.deepEqual(t.written, []);
  assert.equal(t.submitted, 0);
});

test('a wheel turn just before the screen read (its redraw still to come): nothing pasted', async () => {
  const { t, deps } = fakeTab({ wheelBeforeRead: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.status, 409);
  assert.equal(t.pasted, null);
});

test('a box caught halfway through a repaint after the Enter is not a confirmed send', async () => {
  const { t, deps } = fakeTab({ partialAfterSubmit: true });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.body.ok, false);
  assert.equal(t.submitted, 1);
});

test('Claude suspended with a red dot left over: the shell underneath is typed into (Codex round 5)', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: false, needs: true });
  const r = await sendToTab(deps, 'tab', 'pwd');
  assert.equal(r.body.ok, true);
  assert.equal(t.written.join(''), 'pwd');
  assert.equal(t.submitted, 1);
});

test('dialog-like words in old output above a shell prompt do not block a raw send (Codex round 5)', async () => {
  const lines = ['Would you like to see the diff?', 'Do you want to proceed?', '[1]  + suspended  claude', 'user@Mac project % '];
  lines.dimFrom = lines.map(() => -1);
  const shell = { lines, modes: { bracketedPaste: true, cursor: { x: 19, y: 3 } } };
  const { t, deps } = fakeTab({ claude: false, leads: false, shell });
  const r = await sendToTab(deps, 'tab', 'pwd');
  assert.equal(r.body.ok, true);
  assert.equal(t.written.join(''), 'pwd');
  assert.equal(t.submitted, 1);
});

test('tmux, ssh or docker exec leading the terminal: refused, nothing typed (Claude may be behind it, Codex rounds 6 and 7)', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: false, front: 'other' });
  const r = await sendToTab(deps, 'tab', '1');
  assert.equal(r.status, 409);
  assert.deepEqual(t.written, []);
  assert.equal(t.submitted, 0);
});

test('not Claude, but the screen never holds still: refused, nothing typed', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: false, busyScreen: true });
  const r = await sendToTab(deps, 'tab', 'pwd');
  assert.equal(r.status, 409);
  assert.deepEqual(t.written, []);
});

test('Codex leading the terminal is typed into raw', async () => {
  const { t, deps } = fakeTab({ claude: false, leads: false, front: 'codex' });
  const r = await sendToTab(deps, 'tab', 'hello');
  assert.equal(r.body.ok, true);
  assert.equal(t.written.join(''), 'hello');
});

test('what leads the terminal: only the tab\'s own shell or Codex counts', () => {
  const rows = (...r) => r.map(([pid, pgid, comm]) => ({ pid, pgid, comm }));
  assert.equal(classifyFront({ shellPid: 10, shellComm: '-zsh', tpgid: '10', rows: rows(['10', '10', '-zsh']) }), 'shell');
  assert.equal(classifyFront({ shellPid: 10, shellComm: '/bin/bash', tpgid: '10', rows: rows(['10', '10', '/bin/bash'], ['11', '30', 'sleep']) }), 'shell');
  // A login profile that exec'd tmux: the PTY's own process leads, but it is not a shell.
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'tmux', tpgid: '10', rows: rows(['10', '10', 'tmux']) }), 'other');
  // pwsh has no job control: ssh it runs stays in the shell's own group (Codex round 8).
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'pwsh', tpgid: '10', rows: rows(['10', '10', 'pwsh'], ['12', '10', '/usr/bin/ssh']) }), 'other');
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'zsh', tpgid: '20', rows: rows(['10', '10', 'zsh'], ['20', '20', 'node'], ['21', '20', '/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex']) }), 'codex');
  // `exec codex`: the PTY's own process is Codex (Codex round 8).
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'codex', tpgid: '10', rows: rows(['10', '10', 'codex'], ['11', '10', 'codex-code-mode-host']) }), 'codex');
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'zsh', tpgid: '20', rows: rows(['20', '20', 'codex'], ['22', '20', 'docker']) }), 'other');
  for (const comm of ['docker', 'tmux', '/usr/bin/ssh', 'vim', 'python3', 'kubectl', 'limactl', 'node']) {
    assert.equal(classifyFront({ shellPid: 10, shellComm: 'zsh', tpgid: '20', rows: rows(['10', '10', 'zsh'], ['20', '20', comm]) }), 'other', comm);
  }
  // codex in a background group does not make the foreground program Codex.
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'zsh', tpgid: '20', rows: rows(['30', '30', 'codex'], ['20', '20', 'docker']) }), 'other');
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'zsh', tpgid: '', rows: [] }), 'other');
  assert.equal(classifyFront({ shellPid: 10, shellComm: 'zsh', tpgid: '10', rows: [] }), 'other');
});

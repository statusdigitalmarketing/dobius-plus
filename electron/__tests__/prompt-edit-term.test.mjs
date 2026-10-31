import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachPromptEditing } from '../../src/lib/prompt-edit-term.js';

// A one-row stand-in for Claude's default prompt: it keeps text + caret,
// understands arrows, backspace, Enter and bracketed paste, and redraws the
// box (rule, "❯ text", rule) into a fake xterm buffer after every write.
// `exit()` replaces the prompt with a shell, as when Claude quits mid-edit.
const COLS = 40;
function fakeClaude(text, { placeholder = false } = {}) {
  const app = { text, caret: text.length, alive: true, writes: [], submitted: null, held: [], promptOnly: [], drops: [], times: [] };
  const parsed = new Set();
  const dom = {};
  let grid = [];
  let cursor = [0, 0];
  let selection = null;
  const draw = () => {
    const rows = ['earlier output', ...(app.alive ? ['─'.repeat(COLS), `❯\u00a0${app.text}`, '─'.repeat(COLS)] : ['$ ', '', ''])];
    grid = rows.map((r) => [...r.padEnd(COLS, ' ')].slice(0, COLS));
    cursor = app.alive ? [2 + app.caret, 1] : [2, 0];
    for (const fn of parsed) fn();
  };
  const insert = (s) => { app.text = app.text.slice(0, app.caret) + s + app.text.slice(app.caret); app.caret += s.length; };
  const send = (data, opts) => {
    app.writes.push(data);
    app.times.push(Date.now());
    if (opts?.promptOnly) app.promptOnly.push(data);
    if (!app.alive) return;
    let s = data;
    while (s) {
      let m;
      if ((m = /^\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(s))) insert(m[1]);
      else if ((m = /^\x1b\[D/.exec(s))) app.caret = Math.max(0, app.caret - 1);
      else if ((m = /^\x1b\[C/.exec(s))) app.caret = Math.min(app.text.length, app.caret + 1);
      else if ((m = /^\x7f/.exec(s))) { if (app.caret) { app.caret--; app.text = app.text.slice(0, app.caret) + app.text.slice(app.caret + 1); } }
      else if ((m = /^\r/.exec(s))) app.submitted = app.text;
      else { m = [s[0]]; insert(s[0]); }
      s = s.slice(m[0].length);
    }
    setTimeout(draw, 5);
  };
  const term = {
    cols: COLS,
    rows: 3,
    element: {
      addEventListener: (type, fn) => { dom[type] = fn; },
      removeEventListener: (type) => { delete dom[type]; },
      querySelector: () => null,
    },
    modes: { mouseTrackingMode: 'none', applicationCursorKeysMode: false, bracketedPasteMode: true },
    buffer: {
      active: {
        type: 'normal',
        viewportY: 1,
        baseY: 1,
        get cursorX() { return cursor[0]; },
        get cursorY() { return cursor[1]; },
        getNullCell() {
          let ch = '';
          let dim = false;
          return { put(c, d) { ch = c === ' ' ? '' : c; dim = d; }, getChars: () => ch, getWidth: () => 1, isDim: () => (dim ? 1 : 0) };
        },
        getLine: (y) => grid[y] && {
          // An empty prompt shows Claude's dim placeholder, as the real one does.
          getCell: (x, cell) => { cell.put(grid[y][x], placeholder && y === 2 && x >= 2 && !app.text); return cell; },
          translateToString: () => grid[y].join('').trimEnd(),
        },
      },
    },
    onWriteParsed: (fn) => { parsed.add(fn); return { dispose: () => parsed.delete(fn) }; },
    attachCustomKeyEventHandler: () => {},
    hasSelection: () => !!selection,
    getSelectionPosition: () => selection && { start: { x: selection[0], y: 2 }, end: { x: selection[1], y: 2 } },
    select: () => {},
    clearSelection: () => { selection = null; },
  };
  draw();
  const edit = attachPromptEditing(term, send, (d, dropped) => { app.held.push(d); if (d === null) app.drops.push(dropped === true); });
  return {
    app,
    edit,
    select: (a, b) => { selection = [a, b]; },
    // A key as xterm delivers it: keydown (which arms) sees the selection,
    // xterm clears the selection, then the bytes reach onData.
    type: (data) => { dom.keydown?.({}); selection = null; edit.handleData(data); },
    exit: () => { app.alive = false; draw(); },
    hasSelection: () => !!selection,
    scrollUp: () => { term.buffer.active.viewportY = 0; },
  };
}

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const BS = '\x7f';

test('typing over a selection: a proving walk, then backspaces, then the text', async () => {
  const t = fakeClaude('hello world foo');
  t.select(8, 13); // "world"
  t.type('X');
  await wait();
  assert.equal(t.app.text, 'hello X foo');
  assert.equal(t.app.writes.at(-1), 'X');
  assert.equal(t.app.writes.at(-2), BS.repeat(5));
});

test('Backspace on a selection deletes exactly it and sends no extra key', async () => {
  const t = fakeClaude('hello world foo');
  t.select(14, 17); // "foo", runs to the end of the text
  t.type(BS);
  await wait();
  assert.equal(t.app.text, 'hello world ');
});

test('keys typed during an edit wait for it and keep their order', async () => {
  const t = fakeClaude('hello world foo');
  t.select(8, 13);
  t.type('X');
  t.type('Y');
  t.type('\r');
  await wait();
  assert.equal(t.app.text, 'hello XY foo');
  assert.equal(t.app.submitted, 'hello XY foo');
});

test('if the prompt goes away mid-edit, nothing more is sent: no backspace, no text, no queued Enter', async () => {
  const t = fakeClaude('hello world foo');
  t.select(8, 13);
  t.type('X');
  t.type('\r');
  t.exit();
  await wait(1200);
  assert.ok(!t.app.writes.some((w) => w.includes(BS)), JSON.stringify(t.app.writes));
  assert.ok(!t.app.writes.includes('X'));
  assert.ok(!t.app.writes.includes('\r'));
});

test('a pending image paste holds Enter back and replaces the selection', async () => {
  const t = fakeClaude('look at this please');
  t.select(10, 14); // "this"
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  t.type('\r');
  await wait(100);
  assert.equal(t.app.submitted, null, 'Enter waited for the paste');
  resolve("'/tmp/shot.png'");
  await wait();
  assert.equal(t.app.submitted, "look at '/tmp/shot.png' please");
});

test('a pending paste whose prompt is gone is dropped with what was typed after it', async () => {
  const t = fakeClaude('describe');
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  t.type('\r');
  t.exit();
  resolve("'/tmp/shot.png'");
  await wait();
  assert.deepEqual(t.app.writes, []);
});

test('two pending pastes and Enter arrive in the order they were made', async () => {
  const t = fakeClaude('');
  let a; let b;
  t.edit.pasteWhenReady(new Promise((r) => { a = r; }));
  t.edit.pasteWhenReady(new Promise((r) => { b = r; }));
  t.type('\r');
  b('B');
  await wait(50);
  a('A');
  await wait();
  assert.equal(t.app.submitted, 'AB');
});

test('a paste whose save fails does not hold typing forever', async () => {
  const t = fakeClaude('');
  t.edit.pasteWhenReady(Promise.reject(new Error('disk full')));
  t.type('x');
  await wait(50);
  assert.equal(t.app.text, 'x');
});

test('control characters in a pasted path cannot end the paste or press Enter', async () => {
  const t = fakeClaude('');
  t.edit.pasteWhenReady(Promise.resolve("'/tmp/a\x1b[201~\rrm'"));
  await wait(50);
  assert.equal(t.app.writes[0], "\x1b[200~'/tmp/a[201~rm'\x1b[201~");
  assert.equal(t.app.submitted, null);
});

test('a selection made while an edit is running is not edited by the key typed on it', async () => {
  const t = fakeClaude('one two');
  t.select(2, 5); // "one"
  t.type('X');
  t.select(6, 9); // "two", while the first edit is still walking
  t.type(BS);
  t.type('Z'); // later typing still arrives
  await wait();
  assert.equal(t.app.text, 'XZ two');
});

test('with no selection, typing goes straight through', () => {
  const t = fakeClaude('abc');
  t.type('d');
  assert.deepEqual(t.app.writes, ['d']);
});

test('a paste whose save fails after the prompt went away does not release queued Enter', async () => {
  const t = fakeClaude('explain');
  let reject;
  t.edit.pasteWhenReady(new Promise((_, r) => { reject = r; }));
  t.type('\r');
  t.exit();
  reject(new Error('save failed'));
  await wait();
  assert.deepEqual(t.app.writes, []);
});

test('an unreadable prompt (dim placeholder) is still the destination a paste must find', async () => {
  const t = fakeClaude('', { placeholder: true });
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  t.type('\r');
  t.exit();
  resolve("'/tmp/shot.png'");
  await wait();
  assert.deepEqual(t.app.writes, []);
});

test('a paste consumes the selection it replaced, so the next key is plain typing', async () => {
  const t = fakeClaude('hello world foo');
  t.select(8, 13);
  t.edit.pasteWhenReady(Promise.resolve("'/tmp/a'"));
  assert.equal(t.hasSelection(), false);
  await wait();
  t.type('Z');
  await wait();
  assert.equal(t.app.text, "hello '/tmp/a'Z foo");
});

test('a paste anywhere but Claude\'s prompt is left to the caller', () => {
  const t = fakeClaude('');
  t.exit();
  assert.equal(t.edit.pasteWhenReady(Promise.resolve('x')), false);
  t.type('a');
  assert.deepEqual(t.app.writes, ['a'], 'nothing held back');
});

test('scrolling up does not change where a pending paste is headed', async () => {
  const t = fakeClaude('describe');
  t.scrollUp();
  let resolve;
  assert.equal(t.edit.pasteWhenReady(new Promise((r) => { resolve = r; })), true);
  t.type('\r');
  t.exit();
  resolve("'/tmp/shot.png'");
  await wait();
  assert.deepEqual(t.app.writes, [], 'Claude exited: nothing reaches the shell');
});

test('a paste right after an Enter waits for the screen to show where it would land', async () => {
  const t = fakeClaude('/exit');
  t.type('\r'); // its own queue run, already drained when the paste comes
  t.edit.pasteWhenReady(Promise.resolve("'/tmp/report.pdf'"));
  t.type('\r');
  setTimeout(t.exit, 100); // Claude quits, but the screen shows it only now
  await wait(1300);
  assert.equal(t.app.submitted, '/exit');
  assert.deepEqual(t.app.writes, ['\r'], 'neither the path nor the second Enter reached the shell');
});

test('a paste right after Ctrl+D waits too (Ctrl+D twice quits Claude)', async () => {
  const t = fakeClaude('');
  t.type('\x04');
  t.type('\x04');
  t.edit.pasteWhenReady(Promise.resolve("'/tmp/report.pdf'"));
  setTimeout(t.exit, 100);
  await wait(1300);
  assert.deepEqual(t.app.writes, ['\x04', '\x04']);
});

test('Option+Enter is a newline, not a submit: a paste behind it is not delayed', async () => {
  const t = fakeClaude('line');
  t.type('\x1b\r');
  t.edit.pasteWhenReady(Promise.resolve('X'));
  await wait(100);
  assert.ok(t.app.writes.includes('\x1b[200~X\x1b[201~'), JSON.stringify(t.app.writes));
});

test('scrolling away during an edit does not abandon it', async () => {
  const t = fakeClaude('hello world foo');
  t.select(8, 13);
  t.type('X');
  t.scrollUp();
  await wait();
  assert.equal(t.app.text, 'hello X foo');
});

test('input held behind a pending paste is reported the moment it is taken, the drain once it all went out', async () => {
  const t = fakeClaude('look');
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  t.type('\x03');
  // Nothing reached the PTY yet, but main already knows a person typed.
  assert.deepEqual(t.app.writes, []);
  assert.deepEqual(t.app.held, ['\x1b[200~\x1b[201~', '\x03']);
  resolve("'/tmp/shot.png'");
  await wait();
  assert.deepEqual(t.app.writes, ["\x1b[200~'/tmp/shot.png'\x1b[201~", '\x03']);
  assert.deepEqual(t.app.held, ['\x1b[200~\x1b[201~', '\x03', null]);
});

test('typing that goes straight through is not reported as held', async () => {
  const t = fakeClaude('abc');
  t.type('d');
  await wait(0); // keys arrive as separate events
  t.type('\r');
  await wait(50);
  assert.deepEqual(t.app.writes, ['d', '\r']);
  assert.deepEqual(t.app.held, []);
});

test('keys typed during a selection edit are reported as held', async () => {
  const t = fakeClaude('hello world foo');
  t.select(8, 13);
  t.type('X');
  t.type('\r');
  assert.deepEqual(t.app.held, ['X', '\r'], 'the key that starts the edit, then the Enter behind it');
  await wait();
  assert.equal(t.app.held.at(-1), null);
});

test('a key that starts a selection edit is reported before the edit sends anything', async () => {
  const t = fakeClaude('hello world foo');
  t.select(14, 17); // "foo", the caret already at its end: the first leg is empty
  t.type(BS);
  assert.deepEqual(t.app.writes, [], 'nothing reached the PTY yet');
  assert.deepEqual(t.app.held, [BS]);
  await wait();
  assert.equal(t.app.text, 'hello world ');
  assert.equal(t.app.held.at(-1), null);
});

test('a send reserved by the command bar is held from the moment it is accepted until it is released', async () => {
  const t = fakeClaude('');
  const send = t.edit.reserve('hi\r');
  assert.deepEqual(t.app.held, ['hi\r'], 'held before any of its input arrives');
  send.write('h');
  await wait(0);
  send.write('i');
  await wait(20);
  assert.deepEqual(t.app.writes, ['h', 'i']);
  assert.equal(t.app.held.includes(null), false, 'not drained while the send is still coming');
  send.write('\r');
  send.release();
  send.release(); // a second release changes nothing
  await wait(20);
  assert.deepEqual(t.app.held, ['hi\r', null]);
  assert.equal(t.app.submitted, 'hi');
});

test('when the queue drops what it held, the rest of a reserved send is dropped too, Enter included', async () => {
  const t = fakeClaude('draft');
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  const send = t.edit.reserve('tail\r');
  send.write('ta');
  t.exit(); // the prompt goes away under the pending paste
  resolve("'/tmp/shot.png'");
  await wait(50);
  send.write('il');
  send.write('\r');
  send.release();
  await wait(50);
  assert.deepEqual(t.app.writes, [], 'nothing of the send reached the shell');
  assert.equal(t.app.held.at(-1), null);
});

test('a pasted path is marked prompt-only, so main never delivers it late elsewhere; typed keys are not', async () => {
  const t = fakeClaude('look at');
  t.edit.pasteWhenReady(Promise.resolve("'/tmp/a.png'"));
  await wait(50);
  t.type('x');
  await wait(20);
  assert.deepEqual(t.app.promptOnly, ["\x1b[200~'/tmp/a.png'\x1b[201~"]);
  assert.ok(t.app.writes.includes('x'));
});

test('a drain that threw held input away says so; a full drain does not', async () => {
  const t = fakeClaude('Describe ');
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  t.type('\r');
  t.exit(); // the prompt goes away: the paste and the Enter are dropped
  resolve("'/tmp/shot.png'");
  await wait();
  assert.deepEqual(t.app.drops, [true]);
  const u = fakeClaude('ok');
  u.edit.pasteWhenReady(Promise.resolve("'/tmp/a.png'"));
  u.type('\r');
  await wait();
  assert.deepEqual(u.app.drops, [false]);
});

test('a pane that goes away while holding input reports the drop', async () => {
  const t = fakeClaude('Describe ');
  t.edit.pasteWhenReady(new Promise(() => {}));
  t.type('\r');
  t.edit.dispose();
  assert.deepEqual(t.app.drops, [true]);
});

test('input that waited behind a paste goes out paced, not in one burst', async () => {
  const t = fakeClaude('');
  let resolve;
  t.edit.pasteWhenReady(new Promise((r) => { resolve = r; }));
  for (const k of ['h', 'i', '\r']) t.type(k);
  resolve('X');
  await wait();
  const gaps = t.app.times.slice(1).map((x, i) => x - t.app.times[i]);
  assert.equal(t.app.writes.length, 4, JSON.stringify(t.app.writes));
  assert.ok(gaps.every((g) => g >= 15), `gaps ${gaps}`);
  assert.equal(t.app.submitted, 'Xhi');
});

test('a paste whose save failed, or a key typed onto a selection made mid-edit, counts as dropped', async () => {
  const t = fakeClaude('old request ');
  t.edit.pasteWhenReady(Promise.resolve(null));
  t.type('x');
  await wait();
  assert.deepEqual(t.app.drops, [true], 'save failed');
  const u = fakeClaude('one two');
  u.select(2, 5);
  u.type('X'); // an edit starts
  u.select(6, 9); // selection made while it runs
  u.type('\x15');
  await wait();
  assert.deepEqual(u.app.drops, [true], 'the key on the mid-edit selection was lost');
});

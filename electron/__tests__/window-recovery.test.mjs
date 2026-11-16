// window-recovery.js: a dead or failed page is reloaded (capped), a dead GPU repaints every window, nothing during quit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { allowRecovery, renderGoneNeedsReload, loadFailNeedsReload, gpuGoneNeedsRepaint, installWindowRecovery, recoveryUrl, MAX_RECOVERIES, MAX_TOTAL_RECOVERIES } from '../window-recovery.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeWc(type = 'window') {
  const wc = new EventEmitter();
  wc.reloads = 0; wc.invalidates = 0; wc.destroyed = false;
  wc.getType = () => type;
  wc.isDestroyed = () => wc.destroyed;
  wc.reload = () => { wc.reloads += 1; };
  wc.invalidate = () => { wc.invalidates += 1; };
  wc.crashed = true; wc.url = 'file:///app/dist/index.html?project=%2Fp'; wc.loaded = [];
  wc.isCrashed = () => wc.crashed;
  wc.getURL = () => wc.url;
  wc.loadURL = (u) => { wc.loaded.push(u); };
  return wc;
}
function rig(gap, handoffPending, extra = {}) {
  const app = new EventEmitter();
  const logs = [];
  const state = { quitting: false, clock: 1_000_000, windows: [], gap };
  installWindowRecovery({ app, isQuitting: () => state.quitting, log: (k, d) => logs.push([k, d]), allWindows: () => state.windows, handoffPending, ...extra, delayMs: 5, gapMs: state.gap ?? 5, now: () => state.clock });
  const open = (type) => { const wc = fakeWc(type); app.emit('web-contents-created', {}, wc); state.windows.push({ webContents: wc, isDestroyed: () => false }); return wc; };
  return { app, logs, state, open };
}

test('pure rules', () => {
  const t = [];
  for (let i = 0; i < MAX_RECOVERIES; i += 1) assert.equal(allowRecovery(t, 1000 + i), true);
  assert.equal(allowRecovery(t, 2000), false, 'the cap holds inside the window');
  assert.equal(allowRecovery(t, 1000 + 10 * 60_000), true, 'the oldest ages out');
  assert.equal(renderGoneNeedsReload({ reason: 'crashed' }), true);
  assert.equal(renderGoneNeedsReload({ reason: 'oom' }), true);
  assert.equal(renderGoneNeedsReload({ reason: 'killed' }), true);
  assert.equal(renderGoneNeedsReload({ reason: 'clean-exit' }), false);
  assert.equal(loadFailNeedsReload(-102, true), true);
  assert.equal(loadFailNeedsReload(-3, true), false, 'a replaced navigation is not a failure');
  assert.equal(loadFailNeedsReload(-102, false), false, 'a subframe is not the window');
  assert.equal(gpuGoneNeedsRepaint({ type: 'GPU', reason: 'crashed' }), true);
  assert.equal(gpuGoneNeedsRepaint({ type: 'GPU', reason: 'clean-exit' }), false);
  assert.equal(gpuGoneNeedsRepaint({ type: 'Utility', reason: 'crashed' }), false);
});

test('a crashed window page is reloaded once per death, and only app windows', async () => {
  const { open, logs } = rig();
  const win = open('window');
  const pane = open('webview');
  win.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 });
  win.emit('did-fail-load', {}, -2, 'failed', 'file:///x', true); // a second event for the same death
  pane.emit('render-process-gone', {}, { reason: 'crashed' });
  await wait(30);
  assert.equal(win.reloads, 1);
  assert.equal(pane.reloads, 0, 'a webview pane is never reloaded by us');
  assert.equal(logs.filter(([k]) => k === 'diag.window-recovery').length, 1);
  win.emit('render-process-gone', {}, { reason: 'clean-exit' });
  win.emit('did-fail-load', {}, -3, 'aborted', 'file:///x', true);
  win.emit('did-fail-load', {}, -2, 'failed', 'https://x', false);
  await wait(30);
  assert.equal(win.reloads, 1, 'clean exit, aborted navigation and subframes do nothing');
});

test('a page that keeps dying stops after the cap and is reported', async () => {
  const { open, logs, state } = rig();
  const win = open('window');
  for (let i = 0; i < MAX_RECOVERIES + 2; i += 1) {
    win.emit('render-process-gone', {}, { reason: 'crashed' });
    await wait(20);
    state.clock += 1000;
  }
  assert.equal(win.reloads, MAX_RECOVERIES);
  assert.equal(logs.filter(([k]) => k === 'window.recovery-stopped').length, 2);
});

test('nothing is reloaded while quitting, or once the window is gone', async () => {
  const { open, state } = rig();
  const a = open('window');
  const b = open('window');
  b.emit('render-process-gone', {}, { reason: 'crashed' });
  b.destroyed = true;
  state.quitting = true;
  a.emit('render-process-gone', {}, { reason: 'crashed' });
  await wait(30);
  assert.equal(a.reloads, 0);
  assert.equal(b.reloads, 0);
});

test('a dead GPU process repaints every window once, without reloading', async () => {
  const { app, open, logs } = rig();
  const a = open('window');
  const b = open('window');
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed' });
  await wait(30);
  assert.deepEqual([a.invalidates, b.invalidates, a.reloads, b.reloads], [1, 1, 0, 0]);
  assert.match(logs.find(([k]) => k === 'diag.window-recovery')[1], /repainted 2 window/);
});

test('many windows dying at once reload one at a time, with an app-wide cap', async () => {
  const { open, logs } = rig(40);
  const wins = Array.from({ length: 10 }, () => open('window'));
  for (const w of wins) w.emit('render-process-gone', {}, { reason: 'oom' });
  await wait(20);
  assert.equal(wins.reduce((n, w) => n + w.reloads, 0), 1, 'only the first has reloaded so far');
  await wait(45);
  assert.equal(wins.reduce((n, w) => n + w.reloads, 0), 2, 'the next one waits a gap');
  await wait(40 * 12);
  assert.equal(wins.reduce((n, w) => n + w.reloads, 0), MAX_TOTAL_RECOVERIES, 'the app-wide cap stops the storm');
  assert.match(logs.find(([k]) => k === 'window.recovery-stopped')[1], /app-wide/);
});

test('a window that loaded again before its turn is left alone', async () => {
  const { open, logs } = rig();
  const win = open('window');
  win.emit('did-fail-load', {}, -102, 'refused', 'http://localhost:5173', true);
  win.crashed = false;
  win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); // someone reloaded it
  await wait(30);
  assert.equal(win.reloads, 0);
  assert.match(logs.find(([k]) => k === 'diag.window-recovery')[1], /skipped/);
  // A same-document (hash) navigation is not a new load.
  const w2 = open('window');
  w2.emit('render-process-gone', {}, { reason: 'crashed' });
  w2.emit('did-start-navigation', {}, 'file:///x#a', true, true);
  await wait(30);
  assert.equal(w2.reloads, 1);
  // Still dead after a navigation started: reloaded anyway.
  const w3 = open('window');
  w3.emit('render-process-gone', {}, { reason: 'crashed' });
  w3.emit('did-start-navigation', {}, 'file:///x', false, true);
  await wait(30);
  assert.equal(w3.reloads, 1);
});

test('a torn-off window comes back with its saved tab set', async () => {
  assert.equal(recoveryUrl('http://localhost:5173/?project=%2Fp&tearOffTab=term-%2Fp-3&tearOffLabel=x'), 'http://localhost:5173/?project=%2Fp&tearOffTab=term-%2Fp-3&tearOffLabel=x&tearOffRestore=1');
  assert.equal(recoveryUrl('file:///a/index.html?project=%2Fp&tearOffTab=t&tearOffRestore=1'), null);
  assert.equal(recoveryUrl('file:///a/index.html?project=%2Fp'), null);
  assert.equal(recoveryUrl('not a url'), null);
  const { open } = rig();
  const win = open('window');
  win.url = 'file:///a/index.html?project=%2Fp&tearOffTab=term-%2Fp-3';
  win.emit('render-process-gone', {}, { reason: 'crashed' });
  await wait(30);
  assert.deepEqual([win.reloads, win.loaded], [0, ['file:///a/index.html?project=%2Fp&tearOffTab=term-%2Fp-3&tearOffRestore=1']]);
});

test('the gap holds when the queue empties between deaths', async () => {
  const { open, state } = rig(60);
  const a = open('window');
  const b = open('window');
  a.emit('render-process-gone', {}, { reason: 'oom' });
  await wait(20);
  assert.equal(a.reloads, 1);
  state.clock += 10; // 10 ms later, with the queue empty, another window dies
  b.emit('render-process-gone', {}, { reason: 'oom' });
  await wait(25);
  assert.equal(b.reloads, 0, 'not after the short first delay');
  await wait(60);
  assert.equal(b.reloads, 1, 'after the gap from the last reload');
});

test('a tear-off still claiming its PTY reloads into the claim, not the restore', async () => {
  const claiming = new Set();
  const { open } = rig(undefined, (wc) => claiming.has(wc));
  const win = open('window');
  win.url = 'file:///a/index.html?project=%2Fp&tearOffTab=term-%2Fp-3';
  claiming.add(win);
  win.emit('render-process-gone', {}, { reason: 'crashed' });
  await wait(30);
  assert.deepEqual([win.reloads, win.loaded.length], [1, 0]);
});

test('a replacement load that fails too keeps the reload queued', async () => {
  const { open } = rig(30);
  const win = open('window');
  win.crashed = false;
  win.emit('did-fail-load', {}, -102, 'refused', 'http://localhost:5173', true);
  win.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  win.emit('did-fail-load', {}, -102, 'refused', 'http://localhost:5173', true);
  await wait(40);
  assert.equal(win.reloads, 1);
});

test('a window being closed is never reloaded', async () => {
  const closing = new Set();
  const { open, logs } = rig(undefined, undefined, { isClosing: (wc) => closing.has(wc) });
  const win = open('window');
  win.emit('render-process-gone', {}, { reason: 'crashed' });
  closing.add(win);
  await wait(30);
  assert.equal(win.reloads, 0);
  assert.match(logs.find(([k]) => k === 'diag.window-recovery')[1], /closing/);
});

test('a window sending a tab away reloads only after the move settles', async () => {
  const sending = new Set();
  const { open } = rig(10, undefined, { isSendingTab: (wc) => sending.has(wc) });
  const win = open('window');
  sending.add(win);
  win.emit('render-process-gone', {}, { reason: 'crashed' });
  await wait(40);
  assert.equal(win.reloads, 0, 'waits while the tab is moving');
  sending.delete(win);
  await wait(30);
  assert.equal(win.reloads, 1, 'then reloads');
  // A move that never settles does not hold the window blank forever.
  const w2 = open('window');
  sending.add(w2);
  w2.emit('render-process-gone', {}, { reason: 'crashed' });
  await wait(150);
  assert.equal(w2.reloads, 1);
});

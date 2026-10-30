// The electron side of /openTab (bridge-open-main.js) against recording fakes
// for electron, the windows and the terminals (fake-bridge-env.mjs): what a
// window tells main about a tab /openTab opened, and what main makes of it.
// Run: node --import ./electron/__tests__/bridge-open-main-register.mjs ./electron/__tests__/bridge-open-main.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeOpenDeps } from '../bridge-open-main.js';
import * as env from './fake-bridge-env.mjs';

// A window is ready once its page has restored its tabs (window:tabsReady).
let windowReady = () => true;
const deps = createBridgeOpenDeps({
  windowReady: (wc) => windowReady(wc),
  ownerOf: (tabId) => env.terminals.get(tabId)?.wcId,
});

// A project window whose page answers bridge:openTab like ProjectView does:
// it names its new tab, and the tab's pane then starts a PTY in the project.
let counter = 0;
function projectWindow(projectPath) {
  const wc = env.fakeWebContents((ch, req) => {
    if (ch !== 'bridge:openTab') return;
    const tabId = `term-${projectPath}-${counter += 1}`;
    setTimeout(() => {
      env.emit('bridge:tabOpened', wc, req.nonce, tabId);
      env.terminals.set(tabId, { pid: 4242, cwd: projectPath, wcId: wc.id });
    }, 0);
  });
  return wc;
}

test('input prompt editing holds back counts as a person typing, and keeps the tab busy until it drains', async () => {
  const wc = projectWindow('/p/held');
  env.addWindow('/p/held', wc);
  const opened = await deps.openTab('/p/held');
  assert.equal(typeof opened.tabId, 'string', JSON.stringify(opened));
  const watch = deps.watchOutput(opened.tabId, opened.keyCounter);
  assert.equal(watch.keys(), 0);
  assert.equal(deps.inputBusy(opened.tabId), false);

  // Another window cannot reach the tab's state.
  const other = env.fakeWebContents();
  env.emit('terminal:inputHeld', other, opened.tabId, '\x03');
  assert.equal(watch.keys(), 0);
  assert.equal(deps.inputBusy(opened.tabId), false);

  // An image paste is pending and Ctrl+C waits behind it: nothing reached
  // terminal:write, but the window reported both as it took them.
  env.emit('terminal:inputHeld', wc, opened.tabId, '\x1b[200~\x1b[201~');
  env.emit('terminal:inputHeld', wc, opened.tabId, '\x03');
  assert.equal(env.written.length, 0);
  assert.deepEqual(env.heldNotes.at(-1), [opened.tabId, '\x03'], 'Chat hears of it too (a held Ctrl+C cancels)');
  assert.ok(watch.keys() > 0, 'held keys count as typing');
  assert.equal(deps.inputBusy(opened.tabId), true);

  assert.equal(deps.inputHeld(opened.tabId), true, 'Chat waits for it too');
  // The queue drained: no longer busy (the keys stay counted).
  const c0 = env.cancelled.length;
  env.emit('terminal:inputHeld', wc, opened.tabId, null);
  assert.equal(env.cancelled.length, c0, 'a full drain cancels nothing');
  assert.equal(deps.inputBusy(opened.tabId), false);
  assert.ok(watch.keys() > 0);

  // The tab moves to another window while held: the old window's release
  // still clears its hold, and the new owner cannot be blocked by it.
  env.emit('terminal:inputHeld', wc, opened.tabId, 'y');
  const dest = env.fakeWebContents();
  env.terminals.get(opened.tabId).wcId = dest.id;
  // The new owner's held input counts for the request too.
  const before = watch.keys();
  env.emit('terminal:inputHeld', dest, opened.tabId, '\x1b[200~\x1b[201~');
  assert.ok(watch.keys() > before, 'held input from the tab\'s new window counts');
  env.emit('terminal:inputHeld', dest, opened.tabId, null);
  env.emit('terminal:inputHeld', dest, opened.tabId, null);
  assert.equal(deps.inputBusy(opened.tabId), true, 'another window cannot release it');
  env.emit('terminal:inputHeld', wc, opened.tabId, null);
  assert.equal(deps.inputBusy(opened.tabId), false, 'released by the window that held it');
  env.terminals.get(opened.tabId).wcId = wc.id;

  // A drain that threw some of the input away cancels Chat's waiting sends.
  env.emit('terminal:inputHeld', wc, opened.tabId, 'z');
  const c1 = env.cancelled.length;
  env.emit('terminal:inputHeld', wc, opened.tabId, null, true);
  assert.deepEqual(env.cancelled.slice(c1), [opened.tabId]);
  assert.equal(deps.inputBusy(opened.tabId), false);

  // Input main dropped from the current hold (a prompt-only paste) makes its
  // drain a dropped one, even when the window reports it clean.
  env.emit('terminal:inputHeld', wc, opened.tabId, 'p');
  deps.markHeldLost(opened.tabId);
  const c2 = env.cancelled.length;
  env.emit('terminal:inputHeld', wc, opened.tabId, null, false);
  assert.deepEqual(env.cancelled.slice(c2), [opened.tabId]);
  env.emit('terminal:inputHeld', wc, opened.tabId, 'q');
  env.emit('terminal:inputHeld', wc, opened.tabId, null, false);
  assert.equal(env.cancelled.length, c2 + 1, 'the next hold starts clean');
  deps.markHeldLost(opened.tabId); // no hold: nothing to mark

  // A reload forgets a hold the old page never released.
  env.emit('terminal:inputHeld', wc, opened.tabId, 'x');
  assert.equal(deps.inputBusy(opened.tabId), true);
  wc.fire('did-start-loading');
  assert.equal(deps.inputBusy(opened.tabId), false);
  // So does a crashed renderer whose window stays open.
  env.emit('terminal:inputHeld', wc, opened.tabId, 'x');
  const n = env.cancelled.length;
  wc.fire('render-process-gone');
  assert.equal(deps.inputBusy(opened.tabId), false);
  assert.deepEqual(env.cancelled.slice(n), [opened.tabId], 'Chat submits waiting on it are cancelled');
  watch.stop();
});

test('a window opened FOR a request is told so, once, so its first tab is the request\'s and nothing else starts', async () => {
  // The page asks while it restores its tabs, before it reports ready.
  env.windowFactory.make = () => {
    const wc = projectWindow('/p/fresh');
    setTimeout(() => { wc.askedFirst = env.invoke('window:openedForBridge', wc); }, 0);
    return { webContents: wc };
  };
  windowReady = (wc) => wc.askedFirst !== undefined;
  const opened = await deps.openTab('/p/fresh');
  assert.equal(typeof opened.tabId, 'string', JSON.stringify(opened));
  const wc = env.windows.get('/p/fresh').win.webContents;
  assert.deepEqual(env.openedWindows, ['/p/fresh']);
  assert.equal(wc.askedFirst, true, 'the new window skips its default first tab');
  assert.equal(env.invoke('window:openedForBridge', wc), false, 'not after the request has its tab');
  // Exactly one tab was asked of it: the request's.
  assert.equal(wc.sent.filter(([ch]) => ch === 'bridge:openTab').length, 1);

  // A window that was already open was not opened for the request.
  windowReady = () => true;
  const again = await deps.openTab('/p/fresh');
  assert.equal(typeof again.tabId, 'string');
  assert.equal(env.invoke('window:openedForBridge', wc), false);
  assert.deepEqual(env.openedWindows, ['/p/fresh']);
});

test('a page reloaded while the request waits for it still makes no tab of its own', async () => {
  let loads = 0;
  env.windowFactory.make = () => {
    const wc = projectWindow('/p/reload');
    // First page: asks, then reloads before it reports ready; the second asks again.
    const load = () => setTimeout(() => {
      loads += 1;
      const asked = env.invoke('window:openedForBridge', wc);
      (wc.asks ||= []).push(asked);
      if (loads === 1) setTimeout(load, 20); else wc.ready = true;
    }, 0);
    load();
    return { webContents: wc };
  };
  windowReady = (wc) => wc.ready === true;
  const opened = await deps.openTab('/p/reload');
  assert.equal(typeof opened.tabId, 'string', JSON.stringify(opened));
  const wc = env.windows.get('/p/reload').win.webContents;
  assert.deepEqual(wc.asks, [true, true], 'both pages were told');
  assert.equal(env.invoke('window:openedForBridge', wc), false);
  windowReady = () => true;
});

test('a second request into a window another request opened keeps it from making its own tab', async () => {
  // The page starts slowly. Request A opens the window; B arrives just before
  // A's 15s readiness wait runs out; A gives up while B still waits.
  let release;
  env.windowFactory.make = () => {
    const wc = projectWindow('/p/two');
    release = () => { wc.asked = env.invoke('window:openedForBridge', wc); wc.ready = true; };
    return { webContents: wc };
  };
  windowReady = (wc) => wc.ready === true;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const a = deps.openTab('/p/two');
    skew = 14_900;
    const b = deps.openTab('/p/two');
    skew = 15_100; // past A's deadline only
    assert.deepEqual(await a, { error: 'the project window did not finish loading' });
    const wc = env.windows.get('/p/two').win.webContents;
    release();
    assert.equal(wc.asked, true, 'still told while B waits');
    assert.equal(typeof (await b).tabId, 'string');
    assert.equal(env.invoke('window:openedForBridge', wc), false, 'cleared once both ended');
  } finally {
    Date.now = realNow;
    windowReady = () => true;
  }
});

test('a window answering with another project\'s tab id is refused, prefix lookalikes included', async () => {
  windowReady = () => true;
  // The page names a tab of /p/ab-1 (or of /p/a, or a phone tab) for a /p/ab request.
  for (const wrong of ['term-/p/ab-1-7', 'term-/p/a-7', 'term-mobile-1700000000000', 'not-a-tab']) {
    const wc = env.fakeWebContents((ch, req) => {
      if (ch === 'bridge:openTab') setTimeout(() => env.emit('bridge:tabOpened', wc, req.nonce, wrong), 0);
    });
    env.addWindow('/p/ab', wc);
    const r = await deps.openTab('/p/ab');
    assert.deepEqual(r, { error: 'the project window did not add the tab' }, wrong);
  }
  // Its own tab, from its first or an extra window, is taken.
  for (const right of ['term-/p/ab-3', 'term-/p/ab~w-abcd1234-2']) {
    const wc = env.fakeWebContents((ch, req) => {
      if (ch !== 'bridge:openTab') return;
      setTimeout(() => {
        env.emit('bridge:tabOpened', wc, req.nonce, right);
        env.terminals.set(right, { pid: 1, cwd: '/p/ab', wcId: wc.id });
      }, 0);
    });
    env.addWindow('/p/ab', wc);
    assert.equal((await deps.openTab('/p/ab')).tabId, right);
  }
});

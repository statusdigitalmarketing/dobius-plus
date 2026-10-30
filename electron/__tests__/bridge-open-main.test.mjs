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
  assert.ok(watch.keys() > 0, 'held keys count as typing');
  assert.equal(deps.inputBusy(opened.tabId), true);

  // The queue drained: no longer busy (the keys stay counted).
  env.emit('terminal:inputHeld', wc, opened.tabId, null);
  assert.equal(deps.inputBusy(opened.tabId), false);
  assert.ok(watch.keys() > 0);

  // A reload forgets a hold the old page never released.
  env.emit('terminal:inputHeld', wc, opened.tabId, 'x');
  assert.equal(deps.inputBusy(opened.tabId), true);
  wc.fire('did-start-loading');
  assert.equal(deps.inputBusy(opened.tabId), false);
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
  assert.equal(env.invoke('window:openedForBridge', wc), false, 'answered once');
  // Exactly one tab was asked of it: the request's.
  assert.equal(wc.sent.filter(([ch]) => ch === 'bridge:openTab').length, 1);

  // A window that was already open was not opened for the request.
  windowReady = () => true;
  const again = await deps.openTab('/p/fresh');
  assert.equal(typeof again.tabId, 'string');
  assert.equal(env.invoke('window:openedForBridge', wc), false);
  assert.deepEqual(env.openedWindows, ['/p/fresh']);
});

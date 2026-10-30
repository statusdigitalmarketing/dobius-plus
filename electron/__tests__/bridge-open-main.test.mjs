// The electron side of /openTab (bridge-open-main.js) against recording fakes
// for electron, the windows and the terminals (fake-bridge-env.mjs): what a
// window tells main about a tab /openTab opened, and what main makes of it.
// Run: node --import ./electron/__tests__/bridge-open-main-register.mjs ./electron/__tests__/bridge-open-main.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeOpenDeps } from '../bridge-open-main.js';
import * as env from './fake-bridge-env.mjs';

const deps = createBridgeOpenDeps({
  windowReady: () => true,
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

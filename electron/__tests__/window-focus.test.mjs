// src/lib/window-focus.js: native focus from main OR document.hasFocus().
// Globals are stubbed BEFORE import because the module subscribes at load.
import assert from 'node:assert/strict';

let pushFocus = null;
let domFocus = false;
const domListeners = [];
// The initial snapshot says FOCUSED but resolves only after a blur event has
// been pushed: the stale snapshot must not win.
let resolveInitial;
globalThis.document = { hasFocus: () => domFocus };
globalThis.window = {
  electronAPI: {
    windowIsFocused: () => new Promise((r) => { resolveInitial = r; }),
    onWindowFocusChanged: (cb) => { pushFocus = cb; return () => {}; },
  },
  addEventListener: (type, fn) => { if (type === 'focus') domListeners.push(fn); },
  removeEventListener: () => {},
};

const { windowFocused, onWindowFocus } = await import('../../src/lib/window-focus.js');

pushFocus(false); // blur arrives first
resolveInitial(true); // then the older snapshot
await new Promise((r) => setTimeout(r, 0));
assert.equal(windowFocused(), false, 'a stale initial snapshot does not override a newer blur');

// A <webview> pane has focus: DOM says no, native window is still focused.
pushFocus(true);
domFocus = false;
assert.equal(windowFocused(), true, 'native focus covers a focused webview pane');

// Switched to another app: both false.
pushFocus(false);
assert.equal(windowFocused(), false, 'another app in front');

// Automation / native lag: DOM focus alone is enough.
domFocus = true;
assert.equal(windowFocused(), true, 'DOM focus alone counts');

// onWindowFocus fires on native focus gain, not on blur.
let calls = 0;
const off = onWindowFocus(() => { calls += 1; });
pushFocus(true);
pushFocus(false);
assert.equal(calls, 1, 'fires once, on gain only');
off();
pushFocus(true);
assert.equal(calls, 1, 'unsubscribed');

console.log('window-focus: all assertions pass');

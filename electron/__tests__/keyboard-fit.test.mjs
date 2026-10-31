import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardFit, attachKeyboardFit } from '../../mobile/keyboard-fit.js';

function fakeWindow(innerHeight, height, scale = 1, scrollY = 0, chat = true) {
  const listeners = {};
  const classes = new Set();
  const vars = {};
  const win = {
    innerHeight,
    scrollY,
    scrolled: null,
    scrollTo: (x, y) => { win.scrolled = [x, y]; },
    visualViewport: {
      height,
      scale,
      addEventListener: (n, f) => { listeners[n] = f; },
      removeEventListener: (n) => { delete listeners[n]; },
    },
    document: { querySelector: () => (chat ? {} : null), documentElement: {
      classList: { toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
      style: { setProperty: (k, v) => { vars[k] = v; }, removeProperty: (k) => { delete vars[k]; } },
    } },
  };
  return { win, listeners, classes, vars };
}

test('a keyboard is a big gap, not a toolbar, and not a pinch zoom', () => {
  assert.deepEqual(keyboardFit(874, 538), { open: true, height: 538 });
  assert.deepEqual(keyboardFit(874, 800), { open: false, height: null });
  assert.deepEqual(keyboardFit(874, 400, 2), { open: false, height: null });
});

test('opening sizes the app to what shows and scrolls back, closing undoes it', () => {
  const { win, listeners, classes, vars } = fakeWindow(874, 874);
  const detach = attachKeyboardFit(win);
  assert.equal(classes.has('keyboard-open'), false);
  assert.equal(vars['--app-height'], undefined);
  win.visualViewport.height = 538;
  win.scrollY = 300;
  listeners.resize();
  assert.equal(classes.has('keyboard-open'), true);
  assert.equal(vars['--app-height'], '538px');
  assert.deepEqual(win.scrolled, [0, 0]);
  win.visualViewport.height = 874;
  listeners.resize();
  assert.equal(classes.has('keyboard-open'), false);
  assert.equal(vars['--app-height'], undefined);
  detach();
  assert.deepEqual(Object.keys(listeners), []);
});

test('a screen without a chat keeps the scroll that shows its field', () => {
  const { win, listeners } = fakeWindow(874, 874, 1, 0, false);
  attachKeyboardFit(win);
  win.visualViewport.height = 538;
  win.scrollY = 300;
  listeners.resize();
  assert.equal(win.scrolled, null);
});

test('no visual viewport: nothing happens, nothing throws', () => {
  const detach = attachKeyboardFit({ visualViewport: undefined });
  assert.equal(typeof detach, 'function');
  detach();
});

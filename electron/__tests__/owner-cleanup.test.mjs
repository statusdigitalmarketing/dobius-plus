// One 'destroyed' listener per window (v1.0.70). terminal:create added one per
// tab on the same WebContents; 11 tabs at boot tripped Node's MaxListeners
// warning and the list grew with tab churn for as long as the window lived.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/owner-cleanup.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOwnerCleanup } from '../owner-cleanup.js';

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };
const sender = (id) => Object.assign(new EventEmitter(), { id });

check('creating 30 terminals from one window registers exactly ONE destroyed listener', () => {
  const owners = new Map();
  const cleanup = createOwnerCleanup(owners);
  const win = sender(7);
  for (let i = 0; i < 30; i += 1) { owners.set(`term-${i}`, 7); cleanup.hook(win); }
  assert.equal(win.listenerCount('destroyed'), 1);
  assert.equal(cleanup.hookedCount(), 1);
});

check('the sweep drops every id the dying window still owns, and nothing else', () => {
  const owners = new Map([['a', 7], ['b', 7], ['c', 9]]);
  const cleanup = createOwnerCleanup(owners);
  const win7 = sender(7); const win9 = sender(9);
  cleanup.hook(win7); cleanup.hook(win9);
  win7.emit('destroyed');
  assert.deepEqual([...owners.keys()], ['c']);
  assert.equal(cleanup.hookedCount(), 1, 'the dead window is forgotten');
});

check('an id whose ownership was TRANSFERRED to another window survives the old one dying', () => {
  // A tear-off moves a tab to a new window between create and destroy.
  const owners = new Map([['tab', 7]]);
  const cleanup = createOwnerCleanup(owners);
  const win7 = sender(7);
  cleanup.hook(win7);
  owners.set('tab', 9); // claimed by window 9
  win7.emit('destroyed');
  assert.equal(owners.get('tab'), 9);
});

check('a window can be hooked again after it was destroyed (new webContents id reuse is safe)', () => {
  const owners = new Map();
  const cleanup = createOwnerCleanup(owners);
  const win = sender(7);
  assert.equal(cleanup.hook(win), true);
  win.emit('destroyed');
  assert.equal(cleanup.hook(win), true, 'hook again after destroy');
  assert.equal(win.listenerCount('destroyed'), 1);
});

check('hook returns false and adds nothing for a sender without an id or once()', () => {
  const cleanup = createOwnerCleanup(new Map());
  assert.equal(cleanup.hook(null), false);
  assert.equal(cleanup.hook({ once() {} }), false);
  assert.equal(cleanup.hook({ id: 1 }), false);
  assert.equal(cleanup.hookedCount(), 0);
});

check('two windows creating tabs each get one listener, on their OWN webContents', () => {
  const owners = new Map();
  const cleanup = createOwnerCleanup(owners);
  const a = sender(1); const b = sender(2);
  for (let i = 0; i < 5; i += 1) { cleanup.hook(a); cleanup.hook(b); }
  assert.equal(a.listenerCount('destroyed'), 1);
  assert.equal(b.listenerCount('destroyed'), 1);
});

console.log(`\nALL PASS  (${pass} passed)`);

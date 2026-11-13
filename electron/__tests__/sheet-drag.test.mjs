// Phone sheets: swipe down to close (mobile/sheet-drag.js). Driven with exact pointer ids and timestamps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { swipeHandlers } from '../../mobile/sheet-drag.js';

function rig() {
  const el = { style: {}, setPointerCapture() {} };
  const target = { closest: () => null, parentElement: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  let closed = 0;
  const h = swipeHandlers({ current: null }, () => { closed += 1; }, true);
  const ev = (id, y, t) => ({ pointerType: 'touch', isPrimary: id === 1, pointerId: id, clientX: 100, clientY: y, timeStamp: t, target, currentTarget: el });
  const done = () => new Promise((r) => setTimeout(r, 5)).then(() => closed);
  return { el, h, ev, done };
}

test('a short slow drag springs back; a long one closes', async () => {
  const a = rig();
  a.h.onPointerDown(a.ev(1, 100, 0));
  for (let i = 1; i <= 5; i++) a.h.onPointerMove(a.ev(1, 100 + i * 10, i * 100));
  a.h.onPointerUp(a.ev(1, 150, 520));
  assert.equal(await a.done(), 0);
  assert.equal(a.el.style.transform, '');
  const b = rig();
  b.h.onPointerDown(b.ev(1, 100, 0));
  for (let i = 1; i <= 20; i++) b.h.onPointerMove(b.ev(1, 100 + i * 10, i * 100));
  b.h.onPointerUp(b.ev(1, 300, 2010));
  assert.equal(await b.done(), 1);
});

test('a flick closes, but not after the finger paused (Codex P2)', async () => {
  const a = rig();
  a.h.onPointerDown(a.ev(1, 100, 0));
  a.h.onPointerMove(a.ev(1, 110, 5));
  a.h.onPointerMove(a.ev(1, 130, 10));
  a.h.onPointerUp(a.ev(1, 130, 20));
  assert.equal(await a.done(), 1, 'released while moving fast');
  const b = rig();
  b.h.onPointerDown(b.ev(1, 100, 0));
  b.h.onPointerMove(b.ev(1, 110, 5));
  b.h.onPointerMove(b.ev(1, 130, 10));
  b.h.onPointerUp(b.ev(1, 130, 2010));
  assert.equal(await b.done(), 0, 'paused two seconds first');
  assert.equal(b.el.style.transform, '');
});

test('another finger lifting does not end the drag (Codex P2)', async () => {
  const a = rig();
  a.h.onPointerDown(a.ev(1, 100, 0));
  for (let i = 1; i <= 6; i++) a.h.onPointerMove(a.ev(1, 100 + i * 10, i * 100));
  a.h.onPointerDown(a.ev(2, 140, 650));
  a.h.onPointerUp(a.ev(2, 140, 700));
  a.h.onPointerCancel(a.ev(2, 140, 700));
  a.h.onPointerUp(a.ev(1, 160, 1200));
  assert.equal(await a.done(), 0);
  assert.equal(a.el.style.transform, '', 'the sheet went back, not left 60px down');
});

test('a mouse, or a drag starting in an input, never drags', async () => {
  const a = rig();
  a.h.onPointerDown({ ...a.ev(1, 100, 0), pointerType: 'mouse' });
  a.h.onPointerMove(a.ev(1, 400, 10));
  a.h.onPointerUp(a.ev(1, 400, 20));
  assert.equal(await a.done(), 0);
  const b = rig();
  b.h.onPointerDown({ ...b.ev(1, 100, 0), target: { closest: () => ({}), parentElement: null, scrollTop: 0 } });
  b.h.onPointerMove(b.ev(1, 400, 10));
  b.h.onPointerUp(b.ev(1, 400, 20));
  assert.equal(await b.done(), 0);
});

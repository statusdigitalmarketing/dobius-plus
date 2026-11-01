// The phone image viewer's pinch / pan / double-tap math (shared/pinch-zoom.js).
import { clampView, zoomAt, pinchView, doubleTapView, MAX_SCALE } from '../../shared/pinch-zoom.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const r = (v) => ({ s: +v.s.toFixed(3), x: +v.x.toFixed(2), y: +v.y.toFixed(2) });
const size = { w: 300, h: 200 };

check('1x is always centred', clampView({ s: 1, x: 40, y: -9 }, size), { s: 1, x: 0, y: 0 });
check('cannot zoom out past 1x', clampView({ s: 0.4, x: 5, y: 5 }, size), { s: 1, x: 0, y: 0 });
check('cannot zoom past the max', clampView({ s: 9, x: 0, y: 0 }, size).s, MAX_SCALE);
check('at 2x a drag stops at the image edge', clampView({ s: 2, x: 999, y: -999 }, size), { s: 2, x: 150, y: -100 });
check('garbage numbers fall back to centred', clampView({ s: NaN, x: NaN, y: 1 }, size), { s: 1, x: 0, y: 0 });

// The point under the fingers stays under them.
const z = zoomAt({ s: 1, x: 0, y: 0 }, 2, { x: 100, y: 50 });
check('zoom keeps the point under the finger', r(z), { s: 2, x: -100, y: -50 });
const imgPoint = (v, p) => ({ x: (p.x - v.x) / v.s, y: (p.y - v.y) / v.s });
check('same image point before and after', imgPoint(z, { x: 100, y: 50 }), imgPoint({ s: 1, x: 0, y: 0 }, { x: 100, y: 50 }));

// Fingers spread from 100px to 300px apart around (0,0): 3x.
const start = { a: { x: -50, y: 0 }, b: { x: 50, y: 0 }, view: { s: 1, x: 0, y: 0 } };
check('spreading the fingers zooms in', r(pinchView(start, { a: { x: -150, y: 0 }, b: { x: 150, y: 0 } })), { s: 3, x: 0, y: 0 });
check('pinching in stops at 1x', pinchView(start, { a: { x: -10, y: 0 }, b: { x: 10, y: 0 } }).s, 1);
check('moving both fingers pans', r(pinchView(start, { a: { x: -50, y: 30 }, b: { x: 50, y: 30 } })), { s: 1, x: 0, y: 30 });
check('two fingers on one spot change nothing', pinchView({ ...start, b: start.a }, start), start.view);

check('double tap zooms in on the tapped point', r(doubleTapView({ s: 1, x: 0, y: 0 }, { x: 40, y: 20 })), { s: 2.5, x: -60, y: -30 });
check('double tap when zoomed goes back to 1x', doubleTapView({ s: 3, x: 12, y: 4 }, { x: 0, y: 0 }), { s: 1, x: 0, y: 0 });

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

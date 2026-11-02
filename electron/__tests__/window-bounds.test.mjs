// Saved window bounds are kept only on a display connected now (Brett: a
// window saved on an external monitor that is gone reopened off-screen).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitToDisplays } from '../window-bounds.js';

const laptop = { x: 0, y: 25, width: 1470, height: 890 };
const external = { x: 1470, y: -200, width: 2560, height: 1415 };

test('a window on a display still connected keeps its place', () => {
  assert.deepEqual(fitToDisplays({ x: 100, y: 100, width: 1200, height: 800 }, [laptop]), { x: 100, y: 100, width: 1200, height: 800 });
  assert.deepEqual(fitToDisplays({ x: 1600, y: -100, width: 1400, height: 900 }, [laptop, external]), { x: 1600, y: -100, width: 1400, height: 900 }, 'negative coordinates of a real monitor are fine');
});

test('a window saved on a monitor that is gone opens centred on the laptop, sized to fit', () => {
  assert.deepEqual(fitToDisplays({ x: 1600, y: -100, width: 2400, height: 1300 }, [laptop]), { width: 1470, height: 890 });
});

test('only a title strip on screen counts: a window hanging off the top or side moves', () => {
  assert.deepEqual(fitToDisplays({ x: 100, y: -500, width: 1200, height: 800 }, [laptop]), { width: 1200, height: 800 }, 'title bar above the screen');
  assert.deepEqual(fitToDisplays({ x: 1420, y: 100, width: 1200, height: 800 }, [laptop]), { width: 1200, height: 800 }, 'only 50px of it on screen');
  assert.deepEqual(fitToDisplays({ x: 1300, y: 100, width: 1200, height: 800 }, [laptop]), { x: 1300, y: 100, width: 1200, height: 800 }, '170px of it on screen is enough');
});

test('no saved position or no display information leaves things alone', () => {
  assert.deepEqual(fitToDisplays({}, [laptop]), {});
  assert.deepEqual(fitToDisplays({ width: 3000, height: 2000 }, [laptop]), { width: 1470, height: 890 });
  assert.deepEqual(fitToDisplays({ x: 5, y: 5, width: 100, height: 100 }, []), { x: 5, y: 5, width: 100, height: 100 });
  assert.deepEqual(fitToDisplays(null, [laptop]), {});
});

test('a wide window mostly on a left monitor that is gone is not kept once capped', () => {
  assert.deepEqual(fitToDisplays({ x: -1600, y: 100, width: 2400, height: 800 }, [laptop]), { width: 1470, height: 800 });
});

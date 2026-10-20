import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX,
} from '../../src/lib/sidebar-width.js';
import { projectMonogram } from '../../src/lib/project-color.js';

test('sidebar width clamps to its range and rounds', () => {
  assert.equal(clampSidebarWidth(100), SIDEBAR_MIN);
  assert.equal(SIDEBAR_MIN, 240);
  assert.equal(clampSidebarWidth(5000), SIDEBAR_MAX);
  assert.equal(clampSidebarWidth(333.6), 334);
  assert.equal(clampSidebarWidth('360'), 360);
});

test('a missing or corrupt saved width falls back to the default', () => {
  for (const bad of [undefined, null, '', 'wide', NaN, Infinity, {}]) {
    assert.equal(clampSidebarWidth(bad), SIDEBAR_DEFAULT, String(bad));
  }
});

test('monogram: same path, same color; letter from the last segment', () => {
  const a = projectMonogram('/Users/me/Projects (Code)/dobius-plus');
  assert.deepEqual(a, projectMonogram('/Users/me/Projects (Code)/dobius-plus'));
  assert.equal(a.letter, 'D');
  assert.match(a.background, /^hsl\(\d{1,3} 45% 42%\)$/);
  assert.ok(a.hue >= 0 && a.hue < 360);
});

test('monogram: sibling projects get different hues', () => {
  const names = ['better-telehealth', 'b2b-portal', 'axiom-connect', 'pocket-cologne', 'dobius-plus', 'universal-search'];
  const hues = new Set(names.map((n) => projectMonogram(`/Users/me/Projects (Code)/${n}`).hue));
  assert.equal(hues.size, names.length);
});

test('monogram: odd inputs never throw', () => {
  assert.equal(projectMonogram('/Users/me/_private').letter, 'P');
  assert.equal(projectMonogram('/').letter, '?');
  assert.equal(projectMonogram(undefined).letter, '?');
  assert.equal(projectMonogram('/x/.hidden').letter, 'H');
});

test('sidebarCap leaves the terminal 320 beside the other panels', async () => {
  const { sidebarCap, TERMINAL_MIN } = await import('../../src/lib/sidebar-width.js');
  assert.equal(TERMINAL_MIN, 320);
  assert.equal(sidebarCap(1000, 0), 680);
  assert.equal(sidebarCap(1000, 224), 456); // Git panel open
  assert.equal(sidebarCap(1000, 224 + 380), SIDEBAR_MIN); // Git + Git Tree: terminal gives way
  assert.equal(sidebarCap(NaN, 0), SIDEBAR_MAX);
});

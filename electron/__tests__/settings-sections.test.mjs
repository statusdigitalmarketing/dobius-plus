import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SECTIONS, settingsSectionSelector, sectionScrollTop } from '../../src/lib/settings-sections.js';

const settingsSrc = readFileSync(
  fileURLToPath(new URL('../../src/components/Dashboard/Settings.jsx', import.meta.url)), 'utf8');

// Every anchor the page renders, in page order: wrapped components carry a
// literal data-settings-section, Section blocks an id prop.
const anchors = [...settingsSrc.matchAll(/data-settings-section="([^"]+)"|<Section id="([^"]+)" title="([^"]+)"/g)]
  .map((m) => ({ id: m[1] || m[2], title: m[3] }));

test('the side nav lists exactly the sections the Settings page renders, in order', () => {
  assert.deepEqual(anchors.map((a) => a.id), SETTINGS_SECTIONS.map((s) => s.id));
});

test('every Section in Settings.jsx carries an id (an untagged one would be missing from the nav)', () => {
  assert.equal((settingsSrc.match(/<Section /g) || []).length, (settingsSrc.match(/<Section id="/g) || []).length);
});

test('nav labels match the headings on the page', () => {
  for (const a of anchors.filter((x) => x.title)) {
    assert.equal(SETTINGS_SECTIONS.find((s) => s.id === a.id).label, a.title);
  }
});

test('ids are unique and safe inside an attribute selector', () => {
  const ids = SETTINGS_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z]+$/);
  assert.equal(settingsSectionSelector('mobile'), '[data-settings-section="mobile"]');
});

test('sectionScrollTop lands the section just under the scroller top', () => {
  // scroller at viewport y 80, already scrolled 500, section drawn at y 380
  assert.equal(sectionScrollTop({ scrollTop: 500, boxTop: 80, elTop: 380 }), 788);
  // section above the visible area (scrolling back up)
  assert.equal(sectionScrollTop({ scrollTop: 900, boxTop: 80, elTop: -200, pad: 0 }), 620);
  // never negative
  assert.equal(sectionScrollTop({ scrollTop: 0, boxTop: 80, elTop: 85 }), 0);
});

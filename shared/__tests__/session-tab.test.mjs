// latestSessionForTab: newest session wins per tab (v1.0.72 switch-tab fix).
// Run: node ./shared/__tests__/session-tab.test.mjs
import assert from 'node:assert/strict';
import { latestSessionForTab } from '../session-tab.js';

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

const map = {
  'sess-old': { tabId: 'term-a-1', projectPath: '/p', capturedAt: 100 },
  'sess-new': { tabId: 'term-a-1', projectPath: '/p', capturedAt: 300 },
  'sess-other': { tabId: 'term-b-2', projectPath: '/q', capturedAt: 999 },
};

check('returns the most recent session for a tab', () => {
  assert.equal(latestSessionForTab(map, 'term-a-1').sessionId, 'sess-new');
});
check('carries the project path', () => {
  assert.equal(latestSessionForTab(map, 'term-a-1').projectPath, '/p');
});
check('a different tab gets its own session', () => {
  assert.equal(latestSessionForTab(map, 'term-b-2').sessionId, 'sess-other');
});
check('a tab with no session returns null', () => {
  assert.equal(latestSessionForTab(map, 'term-z-9'), null);
});
check('an entry missing capturedAt still resolves (treated as oldest)', () => {
  const m = { s1: { tabId: 't', capturedAt: 5 }, s2: { tabId: 't' } };
  assert.equal(latestSessionForTab(m, 't').sessionId, 's1');
});
check('with expectedProject, only matching entries win (blocks cross-project bleed)', () => {
  const m = {
    'stale-other': { tabId: 'term-x-1', projectPath: '/old', capturedAt: 999 },
    'right-one':   { tabId: 'term-x-1', projectPath: '/new', capturedAt: 100 },
  };
  assert.equal(latestSessionForTab(m, 'term-x-1', '/new').sessionId, 'right-one');
  // no guard = newest wins regardless of project (same as passing null)
  assert.equal(latestSessionForTab(m, 'term-x-1').sessionId, 'stale-other');
  assert.equal(latestSessionForTab(m, 'term-x-1', null).sessionId, 'stale-other');
});
check('with expectedProject and no match, returns null rather than the wrong project', () => {
  const m = { s: { tabId: 't', projectPath: '/a', capturedAt: 5 } };
  assert.equal(latestSessionForTab(m, 't', '/b'), null);
});
check('null/garbage map does not throw', () => {
  assert.equal(latestSessionForTab(null, 't'), null);
  assert.equal(latestSessionForTab({}, 't'), null);
  assert.equal(latestSessionForTab(map, ''), null);
});
console.log(`\nALL PASS  (${pass} passed)`);

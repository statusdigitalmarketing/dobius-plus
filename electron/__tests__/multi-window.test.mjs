// Multiple primary windows per project (v1.0.66). Tab-id uniqueness across
// windows, per-window config buckets, and mobile grouping that splits the
// windowKey back out. Brett runs ~4 windows on one project folder.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { makeTabId } from '../../src/lib/tab-id.js';
import { parseTabId, projectPathFromTabId } from '../tab-id-util.js';

const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-mw-'));
process.env.HOME = TMP_HOME;
process.env.DOBIUS_TEST_USERDATA = path.join(TMP_HOME, 'userdata');
const cfg = await import('../config-manager.js');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

// --- makeTabId: first window unchanged; extra windows get unique, distinct ids ---
const P = '/Users/b/proj';
check('first window keeps the legacy id (zero migration)', makeTabId(P, 3, null), 'term-/Users/b/proj-3');
check("windowKey 'main' is also legacy", makeTabId(P, 3, 'main'), 'term-/Users/b/proj-3');
check('extra window inserts the windowKey', makeTabId(P, 3, 'w-abc123'), 'term-/Users/b/proj~w-abc123-3');
// The whole point: same project + same counter in two different windows must
// NOT collide.
check('two windows, same counter, DIFFERENT ids',
  makeTabId(P, 1, 'w-aaa') !== makeTabId(P, 1, 'w-bbb'), true);
check('extra id still ends in -<digits> (matches TAB_ID_RE / mobile regex)',
  /^term-.+-\d+$/.test(makeTabId(P, 7, 'w-xyz')), true);
check('no-project id unchanged', makeTabId(null, 2, 'w-x'), 'term-main-2');

// --- parseTabId: round-trips makeTabId and is robust to ~ in folder names ---
check('parse first-window id', parseTabId('term-/x/proj-5'), { projectPath: '/x/proj', windowKey: null, counter: '5' });
check('parse extra-window id', parseTabId('term-/x/proj~w-abcd1234-5'), { projectPath: '/x/proj', windowKey: 'w-abcd1234', counter: '5' });
check('~ in a real folder name stays in the path (first window)',
  projectPathFromTabId('term-/Users/s/foo~bar-3'), '/Users/s/foo~bar');
check('~ in a real folder name PLUS an extra window still splits right',
  parseTabId('term-/Users/s/foo~bar~w-abcd1234-3'), { projectPath: '/Users/s/foo~bar', windowKey: 'w-abcd1234', counter: '3' });
check('makeTabId round-trips through parseTabId (extra)',
  parseTabId(makeTabId('/x/proj', 9, 'w-zzzz0000')), { projectPath: '/x/proj', windowKey: 'w-zzzz0000', counter: '9' });
check('non-tab string parses to null', parseTabId('not-a-tab'), null);

// --- per-window config buckets: independent, do not touch the first window ---
cfg.setProjectConfig(P, { tabs: [{ id: 'term-/Users/b/proj-1' }], tabCounter: 1 });
cfg.setPrimaryWindowState('w-aaa', { projectPath: P, tabs: [{ id: 'a1' }, { id: 'a2' }], tabCounter: 2, activeTabId: 'a2' });
cfg.setPrimaryWindowState('w-bbb', { projectPath: P, tabs: [{ id: 'b1' }], tabCounter: 1, activeTabId: 'b1' });
check('first window bucket untouched by extra windows', cfg.getProjectConfig(P).tabs.length, 1);
check('extra window A has its own 2 tabs', cfg.getPrimaryWindowState('w-aaa').tabs.map((t) => t.id), ['a1', 'a2']);
check('extra window B has its own 1 tab', cfg.getPrimaryWindowState('w-bbb').tabs.map((t) => t.id), ['b1']);
check('extra window A remembers its active tab', cfg.getPrimaryWindowState('w-aaa').activeTabId, 'a2');
// A partial update (bounds only) must MERGE, not wipe tabs.
cfg.setPrimaryWindowState('w-aaa', { projectPath: P, bounds: { x: 5, y: 6, width: 800, height: 600 } });
check('bounds merge keeps tabs', cfg.getPrimaryWindowState('w-aaa').tabs.length, 2);
check('bounds stored', cfg.getPrimaryWindowState('w-aaa').bounds, { x: 5, y: 6, width: 800, height: 600 });
// delete
cfg.deletePrimaryWindowState('w-bbb');
check('deleted window bucket is gone', cfg.getPrimaryWindowState('w-bbb'), null);

await fs.rm(TMP_HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

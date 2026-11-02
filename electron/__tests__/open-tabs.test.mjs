// The Tabs sidebar lists only tabs in windows open now (Brett, Asana
// 1220099565720840): config-manager projectsWithTabsFrom with onlyOpen.
const { projectsWithTabsFrom } = await import('../config-manager.js');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const tab = (id) => ({ id, label: id });
// Shaped like Brett's config: two windows open (b2b-portal, inbox-board), and
// saved tabs for every project and worktree he ever opened.
const config = {
  projects: {
    '/p/b2b-portal': { tabs: [tab('term-/p/b2b-portal-1'), tab('term-/p/b2b-portal-2')] },
    '/p/inbox-board': { tabs: [tab('term-/p/inbox-board-1')] },
    '/p/config': { tabs: [tab('term-/p/config-1')] },
    '/p/b2b-portal-fridayhold': { tabs: [tab('term-/p/b2b-portal-fridayhold-1')] },
    '/p/b2b-portal-fluidpay-fee': { tabs: [tab('term-/p/b2b-portal-fluidpay-fee-1')] },
    '/p/empty': { tabs: [] },
  },
  primaryWindows: {
    'w-open1234': { projectPath: '/p/b2b-portal', tabs: [tab('term-/p/b2b-portal~w-open1234-1')] },
    'w-closed99': { projectPath: '/p/b2b-portal', tabs: [tab('term-/p/b2b-portal~w-closed99-1')] },
    'w-other000': { projectPath: '/p/billions', tabs: [tab('term-/p/billions~w-other000-1')] },
  },
};
const ids = (list) => list.map((p) => [p.path, p.tabs.map((t) => t.id)]);

check('without a filter: every saved tab (the old list)', projectsWithTabsFrom(config).map((p) => p.path),
  ['/p/b2b-portal', '/p/inbox-board', '/p/config', '/p/b2b-portal-fridayhold', '/p/b2b-portal-fluidpay-fee', '/p/billions']);

const open = { mainPaths: new Set(['/p/b2b-portal', '/p/inbox-board']), windowKeys: new Set(['w-open1234']) };
check('only the open windows: main windows plus the open extra window', ids(projectsWithTabsFrom(config, open)), [
  ['/p/b2b-portal', ['term-/p/b2b-portal-1', 'term-/p/b2b-portal-2', 'term-/p/b2b-portal~w-open1234-1']],
  ['/p/inbox-board', ['term-/p/inbox-board-1']],
]);

const onlyExtra = { mainPaths: new Set(), windowKeys: new Set(['w-other000']) };
check('an open extra window whose main window is closed still shows', ids(projectsWithTabsFrom(config, onlyExtra)), [
  ['/p/billions', ['term-/p/billions~w-other000-1']],
]);
check('nothing open: nothing listed', projectsWithTabsFrom(config, { mainPaths: new Set(), windowKeys: new Set() }), []);
check('a prototype key is never a project', projectsWithTabsFrom({ projects: JSON.parse('{"__proto__": {"tabs": [{"id": "x"}]}}') }, { mainPaths: new Set(['__proto__']), windowKeys: new Set() }), []);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

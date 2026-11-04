// An update restart must save the window lists while the windows are still open.
// quitAndInstall closes every window BEFORE before-quit runs, so anything computed
// from the live set in that handler sees nothing open and drops every window opened
// this session (Brett, Asana 1220099565720834). The real proof needs Squirrel and two
// signed builds; this pins the order so the recompute cannot quietly come back.
// Run: node ./electron/__tests__/update-restore-list.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const updater = read('auto-updater.js');
const install = updater.slice(updater.indexOf('async function performInstall'), updater.indexOf('export function initAutoUpdater'));
const saved = install.indexOf('saveLiveRestoreListsForUpdate()');
const armed = install.indexOf('setQuittingForUpdate(true)');
const quit = install.indexOf('autoUpdater.quitAndInstall(');
assert.ok(saved > 0, 'performInstall saves the window lists');
assert.ok(saved < armed, 'saved before the flag that arms the install');
assert.ok(armed < quit, 'and before quitAndInstall closes the windows');
console.log('PASS  performInstall saves the lists while the windows are open');

const main = read('main.js');
const start = main.indexOf('if (getQuittingForUpdate()) {\n    if (didTeardown) return;');
assert.ok(start > 0, 'found the update branch of before-quit');
const branch = main.slice(start, main.indexOf('return; // do NOT preventDefault', start));
for (const banned of ['computeRestoreLists(', 'lastOpenProjects =', 'lastTearOffs =', 'lastPrimaryWindows =']) {
  assert.equal(code(branch).includes(banned), false, `update branch of before-quit must not use ${banned}`);
}
assert.ok(code(branch).includes('saveLiveRestoreListsForUpdate()'), 'a quit with windows still open saves them');
assert.ok(branch.includes("'update restart'"), 'it still records why the app quit');
console.log('PASS  before-quit saves only through the helper');

const wm = read('window-manager.js');
const helper = wm.slice(wm.indexOf('export function saveLiveRestoreListsForUpdate'));
assert.ok(/if \(open\.length === 0 && tears\.length === 0 && extras\.length === 0\) return;/.test(helper), 'nothing open never rewrites the lists');
assert.ok(helper.indexOf('return;') < helper.indexOf('computeRestoreLists('), 'and returns before computing them');
console.log('PASS  nothing open leaves the saved lists alone');

const persist = wm.slice(wm.indexOf('function persistOpenProjects()'), wm.indexOf('export function persistOpenProjectsNow'));
assert.ok(persist.indexOf('addLiveWindowsToRestoreLists()') > 0 && persist.indexOf('addLiveWindowsToRestoreLists()') < persist.indexOf('computeRestoreLists('), 'a pending install only ever adds to the lists');
console.log('PASS  a pending install only adds to the lists');

const phase3 = main.slice(main.indexOf('if (quitConfirmed && savedBeforeQuit) {'), main.indexOf('if (quitConfirmed && !savedBeforeQuit) {'));
assert.ok(/if \(!installClosedThem\) \{\s+config\.lastOpenProjects/.test(phase3), 'quitting after a failed install keeps the lists');
const dock = main.slice(main.indexOf("ipcMain.handle('window:dockTab'"));
assert.ok(dock.indexOf('getQuittingForUpdate()') < dock.indexOf('getWindowEntryByWcId'), 'no dock while an install is pending');
console.log('PASS  a failed install and a pending dock cannot lose the lists');

function code(s) { return s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

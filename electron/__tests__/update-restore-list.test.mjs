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

// A second Restart must join the running install: Squirrel refuses a second fetch, and that refusal showed a red
// "Update error" on an update that went on to work (Brett, Asana 1220218501615934). The real proof needs Squirrel.
const once = updater.slice(updater.indexOf('function installOnce()'), updater.indexOf('export function initAutoUpdater'));
assert.ok(once.indexOf('return installing;') > 0 && once.indexOf('return installing;') < once.indexOf('performInstall()'), 'installOnce joins a running install before starting anything');
assert.equal(updater.match(/performInstall\(\)/g).length, 2, 'performInstall is defined once and called only by installOnce');
assert.ok(once.includes('performInstall()'), 'that one caller is installOnce');
assert.ok(install.indexOf("state: 'installing'") > 0 && install.indexOf("state: 'installing'") < saved, 'every window hears about it before the slow part');
const down = updater.slice(updater.indexOf('function standDownInstall()'), updater.indexOf('function broadcast('));
assert.ok(down.includes('installing = null') && down.includes('setQuittingForUpdate(false)'), 'standing down allows another try');
const timeout = install.slice(install.indexOf('installTimer = setTimeout'));
assert.ok(timeout.indexOf('standDownInstall()') > 0 && timeout.indexOf('standDownInstall()') < timeout.indexOf("state: 'error'"), 'a timed out install can be tried again');
const onNative = updater.slice(updater.indexOf("nativeUpdater.prependListener('error'"), updater.indexOf("autoUpdater.on('update-available'"));
assert.ok(onNative.includes('SQUIRREL_BUSY') && onNative.indexOf('SQUIRREL_BUSY') < onNative.indexOf('standDownInstall()'), 'a real Squirrel failure stands the install down, a busy one does not');
const onError = updater.slice(updater.indexOf("autoUpdater.on('error'"));
assert.ok(onError.indexOf('SQUIRREL_BUSY') > 0 && onError.indexOf('SQUIRREL_BUSY') < onError.indexOf('if (installing)') && onError.indexOf('if (installing)') < onError.indexOf("state: 'error'"), 'neither Squirrel being busy nor an overlapping check shows as a failed update');
const late = updater.slice(updater.indexOf("nativeUpdater.on('before-quit-for-update'"), updater.indexOf("autoUpdater.on('update-available'"));
assert.ok(late.includes('setQuittingForUpdate(true)') && late.includes('saveLiveRestoreListsForUpdate()') && late.includes('clearTimeout(installTimer)'), 'a quit after the timeout still counts as an update, with the windows still open');
const check = updater.slice(updater.indexOf('async function safeCheck()'), updater.indexOf('// Centralized install routine'));
assert.ok(check.indexOf('if (installing)', check.indexOf('catch')) > 0 && check.indexOf('if (installing)', check.indexOf('catch')) < check.lastIndexOf("state: 'error'"), 'a check that fails during an install shows nothing');
console.log('PASS  a second Restart joins the install');

function code(s) { return s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

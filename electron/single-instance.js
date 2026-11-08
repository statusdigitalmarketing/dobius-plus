// One running Dobius per userData on Windows. MUST be main.js's second import: right after dev-userdata.js (which sets
// userData, and Electron keys this lock on it) and before every module that reads or writes config at load.
//
// macOS keeps an app to one copy by itself. Windows does not: opening Dobius from the Start menu or a desktop
// shortcut while it runs started a second full Dobius on the same config.json, which reopened the same project
// windows and ran `claude --resume` of the same sessions a second time, two Claude processes on one transcript
// (Max, 2026-11-08, v2.2.8). Now the second launch hands over to the running one (main.js 'second-instance' brings
// a window forward) and exits before anything else loads.
//
// A ship-test instance (DOBIUS_USERDATA_DIR) has its own userData, so its own lock: it still runs beside the real app.
// The Mac is unchanged (a dev run beside the packaged app on one userData keeps working there).
import { app } from 'electron';

export function takesSingleInstanceLock(platform = process.platform) {
  return platform === 'win32';
}

// The installer starts the new version with --updated after an update. It waits for the old copy to close first, but if
// that copy is still letting go of the lock, giving up would leave no Dobius at all after an update (Sam's rule: an
// update never loses windows). So an updated launch retries for up to 10 s; any other launch hands over at once.
export function acquireLock(request, { updated = false, sleep = () => {}, waitMs = 10_000, stepMs = 250 } = {}) {
  if (request()) return true;
  for (let waited = 0; updated && waited < waitMs; waited += stepMs) {
    sleep(stepMs);
    if (request()) return true;
  }
  return false;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (takesSingleInstanceLock()
  && !acquireLock(() => app.requestSingleInstanceLock(), { updated: process.argv.includes('--updated'), sleep: sleepSync })) {
  // process.exit, not app.quit: nothing after this import may run (no restore, no config write, no quit handlers).
  process.exit(0);
}

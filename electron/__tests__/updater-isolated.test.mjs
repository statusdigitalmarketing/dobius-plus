// An isolated instance (DOBIUS_USERDATA_DIR) must never touch the real updater
// cache: a packaged harness deleted ~/Library/Caches/dobius-plus-updater through
// purgeUpdaterCache. HOME points at a throwaway dir before importing, since the
// cache path comes from it at load.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/updater-isolated.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-updater-home-'));
process.env.HOME = home;
process.env.DOBIUS_TEST_USERDATA = path.join(home, 'userdata');
fs.mkdirSync(process.env.DOBIUS_TEST_USERDATA);
const cache = path.join(home, 'Library', 'Caches', 'dobius-plus-updater');
fs.mkdirSync(path.join(cache, 'pending'), { recursive: true });

const { purgeUpdaterCache, handleDownloadPromise, isNetworkError, _test } = await import('../auto-updater.js');

process.env.DOBIUS_USERDATA_DIR = path.join(home, 'ud');
purgeUpdaterCache();
assert.equal(fs.existsSync(path.join(cache, 'pending')), true, 'isolated: the cache survives');
console.log('PASS  an isolated instance leaves the updater cache alone');

delete process.env.DOBIUS_USERDATA_DIR;
purgeUpdaterCache();
assert.equal(fs.existsSync(cache), false, 'the real app still self-heals');
console.log('PASS  the real app still purges a wedged cache');

// A failed background download is handled, never an unhandledRejection (Max, 2026-11-08).
{
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  const warned = [];
  const handled = handleDownloadPromise({ downloadPromise: Promise.reject(new Error('net down')) }, (...a) => warned.push(a.join(' ')));
  await handled;
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(seen.length, 0, 'no unhandled rejection');
  assert.match(warned[0], /download failed: net down/);
  assert.equal(handleDownloadPromise(null), null);
  assert.equal(handleDownloadPromise({}), null);
  console.log('PASS  a failed update download is handled, not left unhandled');
}

// An automatic check that fails offline is quiet: no red banner, one retry; a manual check still shows it (Sam,
// 2026-11-14: "net::ERR_INTERNET_DISCONNECTED ... why does this stay forever").
{
  const offline = new Error('net::ERR_INTERNET_DISCONNECTED');
  assert.equal(isNetworkError(offline), true);
  assert.equal(isNetworkError(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })), true);
  assert.equal(isNetworkError(new Error('sha512 checksum mismatch')), false);
  assert.equal(isNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID')), false, 'a bad certificate is not "offline"');

  const { default: electronUpdater } = await import('electron-updater');
  const au = electronUpdater.autoUpdater;
  const realCheck = au.checkForUpdates;
  const shared = () => { let reject; const pr = new Promise((_r, j) => { reject = j; }); pr.catch(() => {}); return { pr, reject }; };

  // A check the person started shows its error.
  let req = shared();
  au.checkForUpdates = () => req.pr;
  let run = _test.safeCheck('manual');
  req.reject(offline);
  await run;
  assert.equal(_test.lastStatus().state, 'error', 'a manual check that fails offline shows it');
  assert.equal(_test.manualChecks(), 0);

  // An automatic check that starts while the manual one is still out (electron-updater shares the request): the
  // shared failure is still the person's and still shows (Codex P1, PR 14).
  req = shared();
  const m = _test.safeCheck('manual');
  const a = _test.safeCheck('auto');
  req.reject(offline);
  await Promise.all([m, a]);
  assert.equal(_test.lastStatus().state, 'error', 'an overlapping automatic check does not hide the manual one');
  assert.equal(_test.retry(), null, 'and schedules nothing');
  assert.equal(_test.manualChecks(), 0);

  // The reverse: the automatic check is out first and the person's check joins it.
  req = shared();
  const a2 = _test.safeCheck('auto');
  const m2 = _test.safeCheck('manual');
  req.reject(offline);
  await Promise.all([a2, m2]);
  assert.equal(_test.lastStatus().state, 'error', 'a manual check joining an automatic one still shows the failure');
  assert.equal(_test.retry(), null);

  // The error EVENT (it fires before the request rejects) during a manual check is shown.
  req = shared();
  const m3 = _test.safeCheck('manual');
  assert.equal(_test.quietNetworkFailure(offline), false, 'the error event during a manual check is not quiet');
  req.reject(offline);
  await m3;

  // A manual check that starts AND fails on its own request while an automatic one is out: the automatic failure that
  // lands after it must not wipe the person's unread error with a quiet idle.
  const autoReq = shared();
  au.checkForUpdates = () => autoReq.pr;
  const a3 = _test.safeCheck('auto');
  const ownReq = shared();
  au.checkForUpdates = () => ownReq.pr;
  const m4 = _test.safeCheck('manual');
  ownReq.reject(offline);
  await m4;
  assert.equal(_test.manualChecks(), 0);
  autoReq.reject(offline);
  await a3;
  assert.equal(_test.lastStatus().state, 'error', "the person's error stays up");
  assert.equal(_test.retry(), null);
  au.checkForUpdates = () => req.pr;

  // An automatic check on its own, offline: quiet, one retry.
  req = shared();
  run = _test.safeCheck('auto');
  req.reject(offline);
  await run;
  assert.deepEqual(_test.lastStatus(), { state: 'idle' }, 'a stale error banner is replaced');
  const first = _test.retry();
  assert.notEqual(first, null, 'one retry pending');
  assert.equal(_test.quietNetworkFailure(offline), true);
  assert.equal(_test.retry(), first, 'a second offline failure does not stack a second retry');
  assert.equal(_test.quietNetworkFailure(new Error('sha512 checksum mismatch')), false, 'a real failure still shows');
  _test.setPending({ version: '999.0.0' });
  _test.quietNetworkFailure(offline);
  assert.deepEqual(_test.lastStatus(), { state: 'ready', version: '999.0.0' }, 'a downloaded update keeps its Restart');
  _test.clearRetry();
  _test.setPending(null);
  au.checkForUpdates = realCheck;
  console.log('PASS  an automatic check that fails offline stays quiet and retries once');
}

fs.rmSync(home, { recursive: true, force: true });
process.exit(0);

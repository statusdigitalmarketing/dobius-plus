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

  _test.setCheckSource('manual');
  assert.equal(_test.quietNetworkFailure(offline), false, 'a check the person started shows its error');
  _test.setCheckSource('auto');
  assert.equal(_test.quietNetworkFailure(new Error('sha512 checksum mismatch')), false, 'a real failure still shows');
  assert.equal(_test.quietNetworkFailure(offline), true);
  assert.deepEqual(_test.lastStatus(), { state: 'idle' }, 'a stale error banner is replaced');
  const first = _test.retry();
  assert.equal(_test.quietNetworkFailure(offline), true);
  assert.equal(_test.retry(), first, 'a second offline failure does not stack a second retry');
  assert.equal(_test.clearRetry(), true, 'one retry pending');
  assert.equal(_test.clearRetry(), false, 'never two');
  _test.setPending({ version: '999.0.0' });
  _test.quietNetworkFailure(offline);
  assert.deepEqual(_test.lastStatus(), { state: 'ready', version: '999.0.0' }, 'a downloaded update keeps its Restart');
  _test.clearRetry();
  _test.setPending(null);
  console.log('PASS  an automatic check that fails offline stays quiet and retries once');
}

fs.rmSync(home, { recursive: true, force: true });
process.exit(0);

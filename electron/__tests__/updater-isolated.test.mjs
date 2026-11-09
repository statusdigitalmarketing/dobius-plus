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

const { purgeUpdaterCache, handleDownloadPromise } = await import('../auto-updater.js');

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

fs.rmSync(home, { recursive: true, force: true });
process.exit(0);

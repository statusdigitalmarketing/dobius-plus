// The [Image #N] preview returns only bytes Dobius saved: a planted file, a symlink swap, a symlinked folder, a file
// that grew past the cap, or changed bytes all read as null.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordSavedImage, readSavedImage, _test } from '../pasted-image-store.js';

function setup() {
  _test.reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-'));
  const ud = path.join(root, 'ud'); const dir = path.join(root, 'clip');
  fs.mkdirSync(ud); fs.mkdirSync(dir);
  return { root, ud, dir };
}
const NAME = 'clipboard-1700000000000.png';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('a recorded image reads back; a planted one with a valid name does not', async () => {
  const { root, ud, dir } = setup();
  fs.writeFileSync(path.join(dir, NAME), PNG); recordSavedImage(NAME, PNG);
  assert.deepEqual(await readSavedImage(dir, NAME, 1024), PNG);
  fs.writeFileSync(path.join(dir, 'clipboard-1700000000001.png'), 'PRIVATE TEXT');
  assert.equal(await readSavedImage(dir, 'clipboard-1700000000001.png', 1024), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('changed bytes, a symlinked file and a symlinked folder are refused', async () => {
  const { root, ud, dir } = setup();
  fs.writeFileSync(path.join(dir, NAME), PNG); recordSavedImage(NAME, PNG);
  fs.writeFileSync(path.join(dir, NAME), 'PRIVATE TEXT');
  assert.equal(await readSavedImage(dir, NAME, 1024), null, 'same name, different bytes');
  const secret = path.join(root, 'secret.txt'); fs.writeFileSync(secret, PNG); // even matching bytes via a link
  fs.rmSync(path.join(dir, NAME)); fs.symlinkSync(secret, path.join(dir, NAME));
  await assert.rejects(readSavedImage(dir, NAME, 1024), (e) => e.code === 'ELOOP');
  const other = path.join(root, 'elsewhere'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, NAME), PNG);
  const linked = path.join(root, 'clip-link'); fs.symlinkSync(other, linked);
  assert.equal(await readSavedImage(linked, NAME, 1024), null, 'a symlinked folder is not the folder');
  fs.rmSync(root, { recursive: true, force: true });
});

test('over the cap is refused, and only this run\'s records count', async () => {
  const { root, ud, dir } = setup();
  const big = Buffer.alloc(2048, 7);
  fs.writeFileSync(path.join(dir, NAME), big); recordSavedImage(NAME, big);
  assert.equal(await readSavedImage(dir, NAME, 1024), null);
  fs.writeFileSync(path.join(dir, NAME), PNG); recordSavedImage(NAME, PNG);
  assert.deepEqual(await readSavedImage(dir, NAME, 1024), PNG);
  // Nothing on disk vouches for an image: a forged records file next to userData changes nothing.
  fs.writeFileSync(path.join(ud, 'pasted-images.json'), JSON.stringify({ images: [['clipboard-1700000000002.png', 'x']] }));
  fs.writeFileSync(path.join(dir, 'clipboard-1700000000002.png'), 'PRIVATE TEXT');
  assert.equal(await readSavedImage(dir, 'clipboard-1700000000002.png', 1024), null);
  _test.reset();
  assert.equal(await readSavedImage(dir, NAME, 1024), null, 'records are per run');
  assert.equal(await readSavedImage(dir, '../clipboard-1700000000000.png', 1024), null, 'name only');
  fs.rmSync(root, { recursive: true, force: true });
});

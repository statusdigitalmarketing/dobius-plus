// Which clipboard images Dobius itself saved, so the terminal's [Image #N] preview (terminal:readPastedImage) returns
// only those. A matching file name proves nothing: any process can drop clipboard-<ms>.png into the temp folder, or
// swap a checked file for a symlink before it is read. So the save handler records the SHA-256 of the bytes it wrote,
// and a read returns bytes only when they hash to a record: whatever happens to the folder, the preview can only ever
// show an image the person pasted into Dobius. The read itself refuses a symlinked folder or file and is bounded.
//
// Kept in <userData>/pasted-images.json so a preview still opens after a restart (the renderer keeps its label map
// across restarts too). ponytail: capped at MAX_RECORDS names, oldest dropped; the file is rewritten on each save
// (a paste is a human action, so a few hundred small writes a day at most).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_RECORDS = 300;
const FILE = 'pasted-images.json';
const NAME_RE = /^clipboard-\d{10,16}\.(png|jpg|gif|webp)$/;

let records = null; // Map name -> sha256 hex, oldest first
let fileDir = null;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function load(userDataDir) {
  if (records && fileDir === userDataDir) return records;
  records = new Map();
  fileDir = userDataDir;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataDir, FILE), 'utf8'));
    if (Array.isArray(parsed?.images)) {
      for (const r of parsed.images.slice(-MAX_RECORDS)) {
        if (Array.isArray(r) && typeof r[0] === 'string' && NAME_RE.test(r[0]) && /^[0-9a-f]{64}$/.test(r[1])) records.set(r[0], r[1]);
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('[pasted-images] records unreadable, starting empty:', err?.message || err);
  }
  return records;
}

function persist() {
  const target = path.join(fileDir, FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ images: [...records] }), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn('[pasted-images] could not save records:', err?.message || err);
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
  }
}

/** The save handler wrote `buf` as `name`: remember its hash. */
export function recordSavedImage(userDataDir, name, buf) {
  if (!NAME_RE.test(name) || !Buffer.isBuffer(buf)) return;
  const all = load(userDataDir);
  all.delete(name);
  all.set(name, sha(buf));
  while (all.size > MAX_RECORDS) all.delete(all.keys().next().value);
  persist();
}

/**
 * The bytes of `name` inside `dir`, only when they are exactly what the save handler recorded for that name; null
 * when the file is gone, too big, not a plain file, reached through a symlink, or its bytes differ.
 */
export async function readSavedImage(userDataDir, dir, name, maxBytes) {
  if (!NAME_RE.test(name)) return null;
  const want = load(userDataDir).get(name);
  if (!want) return null;
  const dst = await fs.promises.lstat(dir);
  if (!dst.isDirectory()) return null; // a symlinked folder lstats as a link, not a directory
  const fh = await fs.promises.open(path.join(dir, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    // Read at most one byte past the cap, so a file that grew after the stat cannot make this read unbounded.
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    if (got > maxBytes) return null;
    const bytes = buf.subarray(0, got);
    return sha(bytes) === want ? bytes : null;
  } finally {
    await fh.close();
  }
}

export const _test = { reset() { records = null; fileDir = null; } };

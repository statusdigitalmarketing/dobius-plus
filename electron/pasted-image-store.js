// Which clipboard images Dobius itself saved, so the terminal's [Image #N] preview (terminal:readPastedImage) returns
// only those. A matching file name proves nothing: any process can drop clipboard-<ms>.png into the temp folder, or
// swap a checked file for a symlink before it is read. So the save handler records the SHA-256 of the bytes it wrote,
// and a read returns bytes only when they hash to a record: whatever happens to the folder, the preview can only ever
// show an image the person pasted into this run of Dobius. The read itself refuses a symlinked folder or file and is
// bounded.
//
// The records live in memory only. A file of hashes on disk could be written by anything that can write there, and
// then it would vouch for bytes Dobius never saved. Cost: after a restart, older labels say the image cannot be shown.
// ponytail: capped at MAX_RECORDS names, oldest dropped.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_RECORDS = 300;
const NAME_RE = /^clipboard-\d{10,16}\.(png|jpg|gif|webp)$/;
const records = new Map(); // name -> sha256 hex, oldest first

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** The save handler wrote `buf` as `name`: remember its hash. */
export function recordSavedImage(name, buf) {
  if (!NAME_RE.test(name) || !Buffer.isBuffer(buf)) return;
  records.delete(name);
  records.set(name, sha(buf));
  while (records.size > MAX_RECORDS) records.delete(records.keys().next().value);
}

/**
 * The bytes of `name` inside `dir`, only when they are exactly what the save handler recorded for that name; null
 * when the file is gone, too big, not a plain file, reached through a symlink, or its bytes differ.
 */
export async function readSavedImage(dir, name, maxBytes) {
  if (!NAME_RE.test(name)) return null;
  const want = records.get(name);
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

export const _test = { reset() { records.clear(); } };

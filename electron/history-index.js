// ~/.claude/history.jsonl, read once and then only what was appended.
//
// Why this exists (crash 2026-11-09, 2.2.10, 18 hours up): every prompt typed in
// any of ~45 Claude sessions appends a line to history.jsonl, the file watcher
// tells EVERY window, and each window called data:loadHistory, which read and
// parsed the whole file (14MB, 48,757 lines and growing forever). Thirteen
// windows meant thirteen to twenty-four full copies in flight at once: a 14MB
// Buffer, a 28MB two-byte string, its split lines and ~49k parsed objects EACH.
// The main heap swung between 300MB and 2.7GB about once a minute (stall log),
// and at 2.7GB the decode of one more copy (Buffer -> string,
// node::StringBytes::Encode -> v8::String::NewFromTwoByte) failed and V8
// aborted the process with SIGTRAP.
//
// Now: one index per file, built in fixed 1MB reads, never holding the file as
// one string. Later calls read only the bytes appended since, and concurrent
// callers share one update. It keeps what loadHistory and the history-derived
// stats need (the newest entry per session, per-day and per-hour counts),
// never the parsed lines.

import fs from 'fs/promises';
import { HISTORY_PATH } from './data-utils.js';

// Claude Code writes these request snapshots into transcripts; data-utils'
// parseJsonl always skipped them, so the index does too.
const REQUEST_BLOB_TYPE = 'api-request-blob';

const CHUNK_BYTES = 1024 * 1024;
// A history line is one prompt; the largest on Sam's Mac is 130KB. A line past
// this is skipped without ever being decoded, so no single line can become a
// huge string.
const LINE_MAX_BYTES = 4 * 1024 * 1024;
// The bytes just before the read point: if they changed, the file was rewritten
// rather than appended to, and the index starts over.
const PROBE_BYTES = 64;

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function freshIndex(ino) {
  return {
    ino,
    offset: 0, // bytes consumed, always just past a newline
    size: 0, // the file's size at the last read (offset plus any unfinished last line)
    mtimeMs: 0,
    probe: '', // hex of the PROBE_BYTES before `offset`
    bySession: new Map(), // sessionId -> { sessionId, project, display, timestamp }
    byDay: new Map(), // 'YYYY-MM-DD' -> { messageCount, sessions: Set }
    hourCounts: {},
    projects: new Set(),
    // Lines ingested so far, and the line number at which each project last
    // had a prompt: lets a reader holding an earlier `seq` ask which projects
    // changed since (projectsSince). Bounded by the number of projects.
    seq: 0,
    projectSeq: new Map(),
  };
}

function ingest(idx, text) {
  let e;
  try { e = JSON.parse(text); } catch { return; }
  if (!e || typeof e !== 'object' || e.type === REQUEST_BLOB_TYPE) return;
  idx.seq += 1;
  if (typeof e.project === 'string' && e.project) idx.projectSeq.set(e.project, idx.seq);
  const ts = typeof e.timestamp === 'number' && Number.isFinite(e.timestamp) ? e.timestamp : 0;
  if (typeof e.sessionId === 'string' && e.sessionId) {
    const existing = idx.bySession.get(e.sessionId);
    // Same rule loadHistory always had: the newest entry wins, ties go to the later line.
    if (!existing || (ts && ts >= existing.timestamp)) {
      idx.bySession.set(e.sessionId, {
        sessionId: e.sessionId,
        project: typeof e.project === 'string' ? e.project : '',
        display: typeof e.display === 'string' ? e.display : '',
        timestamp: ts,
      });
    }
  }
  if (!ts) return;
  const d = new Date(ts);
  const date = localDay(d);
  let day = idx.byDay.get(date);
  if (!day) { day = { messageCount: 0, sessions: new Set() }; idx.byDay.set(date, day); }
  day.messageCount += 1;
  if (typeof e.sessionId === 'string' && e.sessionId) day.sessions.add(e.sessionId);
  if (typeof e.project === 'string' && e.project) idx.projects.add(e.project);
  const h = d.getHours();
  idx.hourCounts[h] = (idx.hourCounts[h] || 0) + 1;
}

async function probeAt(fh, at) {
  const len = Math.min(PROBE_BYTES, at);
  if (!len) return '';
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, at - len);
  return buf.subarray(0, bytesRead).toString('hex');
}

/**
 * An index over one JSONL history file. `read()` brings it up to date and
 * returns it; never mutate what it returns.
 */
export function createHistoryIndex(file = HISTORY_PATH) {
  let idx = null;

  async function update() {
    let st;
    try {
      st = await fs.stat(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') console.warn('[history-index] stat failed:', err?.message);
      idx = freshIndex(0);
      return idx;
    }
    if (!idx || idx.ino !== st.ino || st.size < idx.size) idx = freshIndex(st.ino);
    if (st.size === idx.size && st.mtimeMs === idx.mtimeMs) return idx;
    // Claude only ever appends, and an append grows the file. Modified without
    // growing means it was edited in place somewhere the probe cannot see: read
    // it again from the start (once, ~80ms for 14MB). Compared with the size
    // last seen, not the read point: an unfinished last line sits between them.
    if (st.size === idx.size && idx.size > 0) idx = freshIndex(st.ino);

    const fh = await fs.open(file, 'r');
    try {
      if (idx.offset > 0 && (await probeAt(fh, idx.offset)) !== idx.probe) idx = freshIndex(st.ino);
      // The probe is taken from the bytes actually parsed, never read again
      // afterwards: a rewrite landing between the last read and a later probe
      // read would pair the old entries with the new file's bytes.
      let before = Buffer.from(idx.probe, 'hex'); // up to PROBE_BYTES read before `chunk`
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      let pos = idx.offset;
      let pending = []; // copies of the current line's earlier pieces
      let pendingLen = 0;
      let skipping = false; // the current line is past LINE_MAX_BYTES
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, st.size - pos), pos);
        if (!bytesRead) break;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        let nl;
        while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
          const piece = chunk.subarray(start, nl);
          if (!skipping && pendingLen + piece.length <= LINE_MAX_BYTES) {
            const line = pendingLen ? Buffer.concat([...pending, piece]) : piece;
            if (line.length) ingest(idx, line.toString('utf8'));
          }
          pending = [];
          pendingLen = 0;
          skipping = false;
          start = nl + 1;
          idx.offset = pos + start;
        }
        if (start > 0) {
          const head = chunk.subarray(Math.max(0, start - PROBE_BYTES), start);
          const probe = head.length < PROBE_BYTES
            ? Buffer.concat([before, head]).subarray(-PROBE_BYTES)
            : head;
          idx.probe = probe.toString('hex');
        }
        before = Buffer.concat([before, chunk.subarray(Math.max(0, bytesRead - PROBE_BYTES))]).subarray(-PROBE_BYTES);
        const rest = chunk.subarray(start);
        if (!skipping && rest.length) {
          if (pendingLen + rest.length > LINE_MAX_BYTES) {
            skipping = true;
            pending = [];
            pendingLen = 0;
          } else {
            pending.push(Buffer.from(rest)); // buf is reused for the next read
            pendingLen += rest.length;
          }
        }
        pos += bytesRead;
      }
      // A last line without its newline yet is still being written: it is read
      // again, whole, on the next call.
      idx.mtimeMs = st.mtimeMs;
      idx.size = st.size;
    } catch (err) {
      // A read that failed part way leaves an index nobody can vouch for (an
      // edit before the next call would go unnoticed): start over next time.
      idx = null;
      throw err;
    } finally {
      await fh.close().catch(() => {});
    }
    return idx;
  }

  return { read: singleFlight(update) };
}

/**
 * One run of `fn` at a time, shared by every caller. A call that arrives while
 * a run is going gets the NEXT run, not the current one: the current one may
 * have started before whatever the caller is reacting to (an append the file
 * watcher just reported), and no second event would come to correct it. Any
 * number of such calls share that one next run.
 */
export function singleFlight(fn) {
  let running = null;
  let queued = null;
  const run = () => {
    running = Promise.resolve().then(fn).finally(() => { running = null; });
    return running;
  };
  return () => {
    if (!running) return run();
    if (!queued) {
      queued = running.catch(() => {}).then(() => {
        queued = null;
        return running || run();
      });
    }
    return queued;
  };
}

/**
 * The projects that had a prompt in `idx` after line `seq` (an earlier
 * reading's idx.seq). `null` when that cannot be told: a different index
 * object (the file was rewritten and re-read) or no earlier reading.
 */
export function projectsSince(idx, prevIdx, prevSeq) {
  if (!idx || !prevIdx || idx !== prevIdx || !Number.isFinite(prevSeq)) return null;
  const out = [];
  for (const [project, at] of idx.projectSeq) if (at > prevSeq) out.push(project);
  return out;
}

export const historyIndex = createHistoryIndex();

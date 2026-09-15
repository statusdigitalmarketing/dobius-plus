// Reading Codex CLI sessions for the history list (v1.0.72).
//
// Sam: "i dont mind having codex session history but i want there to be a
// filter and have it default to claude." Codex stores each session as
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. Record 0 is a
// `session_meta`; user/assistant turns are `response_item` (payload.type
// 'message', role user|assistant, content [{type:'input_text'|'text', text}])
// and, in some versions, `event_msg` (payload.type user_message/agent_message,
// payload.message a string).
//
// Two facts drive the parsing:
//   1. Most sessions are HEADLESS `codex exec` runs (Dobius's own reviews):
//      296 of the last 300 on this Mac. They are noise in a picker, so the
//      caller hides originator 'codex_exec' / source 'exec' by default.
//   2. The first user turn is almost always the injected AGENTS.md /
//      environment_context preamble, not the person's prompt. A useful title
//      skips that; the authoritative title is Codex's own session_index.jsonl
//      thread_name when present.
//
// Everything here is pure over text the caller has already read (a bounded
// head), so it is unit-tested without touching the filesystem.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_HOME = () => path.join(os.homedir(), '.codex');
export const CODEX_SESSIONS_DIR = () => path.join(CODEX_HOME(), 'sessions');

// A user turn that is really injected context, not something the person typed.
const INJECTED_PREFIXES = [
  '# AGENTS.md',
  '<environment_context>',
  '<user_instructions>',
  '# Codex',
  '<context>',
  '<recommended_plugins>',
];

function looksInjected(text) {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'input_text' || b.type === 'text' || typeof b.text === 'string'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join(' ');
}

function tsToMs(ts) {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') { const n = new Date(ts).getTime(); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/**
 * Parse the bounded HEAD of a rollout file. Returns the session descriptor, or
 * null when there is no session_meta (not a codex rollout, or a truncated read
 * that clipped record 0).
 *
 * @param {string} headText  the first chunk of the file (session_meta lives in line 0)
 * @param {{ indexTitle?: string|null }} [opts]
 */
export function parseCodexSessionHead(headText, { indexTitle = null } = {}) {
  if (typeof headText !== 'string' || !headText) return null;
  let meta = null;
  let firstRealUser = '';
  let latestTs = 0;

  for (const line of headText.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // a clipped final line
    if (!rec || typeof rec !== 'object') continue; // null / primitive line: skip, do not throw
    const p = rec.payload || {};
    const recTs = tsToMs(rec.timestamp) || tsToMs(p.timestamp);
    if (recTs > latestTs) latestTs = recTs;

    if (rec.type === 'session_meta' && !meta) {
      meta = {
        id: typeof p.id === 'string' ? p.id : null,
        cwd: typeof p.cwd === 'string' ? p.cwd : null,
        originator: typeof p.originator === 'string' ? p.originator : null,
        source: typeof p.source === 'string' ? p.source : null,
        timestamp: tsToMs(p.timestamp),
      };
      continue;
    }
    if (firstRealUser) continue; // already have the prompt we want

    let role = null;
    let text = '';
    if (rec.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      role = 'user'; text = textFromContent(p.content);
    } else if (rec.type === 'event_msg' && p.type === 'user_message') {
      role = 'user'; text = typeof p.message === 'string' ? p.message : '';
    }
    if (role === 'user') {
      text = String(text).trim();
      if (text && !looksInjected(text)) firstRealUser = text;
    }
  }

  if (!meta) return null;
  const isExec = meta.originator === 'codex_exec' || meta.source === 'exec';
  const title = (typeof indexTitle === 'string' && indexTitle.trim())
    ? indexTitle.trim()
    : (firstRealUser || 'Codex session');
  return {
    sessionId: meta.id,
    cwd: meta.cwd,
    isExec,
    timestamp: meta.timestamp || latestTs,
    preview: title.replace(/\s+/g, ' ').slice(0, 200),
  };
}

/**
 * The uuid at the end of a rollout filename, so a title can be matched to
 * session_index.jsonl (which keys by that id) without reading the file.
 * rollout-2026-09-14T11-31-32-01a0a08b-838c-73e2-a584-0f3fa5133268.jsonl
 */
export function sessionIdFromFilename(name) {
  const m = /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name || '');
  return m ? m[1] : null;
}

/**
 * Read session_index.jsonl into id -> thread_name. Last write wins (the file
 * appends a new line each time a thread is renamed). Bounded + best-effort:
 * a missing or malformed index just means titles fall back to the first user
 * message.
 */
/**
 * List recent Codex sessions as history items, same shape as loadAllSessions'
 * Claude items plus `source: 'codex'`. Bounded for a home with tens of
 * thousands of rollouts: only the newest `limit` files are head-read (16KB
 * each: session_meta is line 0 and the first prompt is a few records in).
 *
 * @param {{ limit?: number, includeExec?: number|boolean, projectFilter?: string|null, timeAgo?: (ms:number)=>string, mapLimit?: Function }} opts
 */
export async function listCodexSessions({ limit = 50, includeExec = false, projectFilter = null, timeAgo = null, hardFileCap = 12000, excludePaths = null } = {}) {
  // ponytail: interactive sessions buried under more than hardFileCap of the
  // newest headless `codex exec` files won't list. 12000 covers this machine's
  // exec:interactive ratio with margin; the walk still early-stops at `limit`
  // interactive found, so the full cost is paid only when there are genuinely
  // fewer than `limit` interactive sessions in that window.
  const root = CODEX_SESSIONS_DIR();
  const index = await readSessionIndex();
  const descNums = async (dir) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    return ents.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name).sort((a, b) => Number(b) - Number(a));
  };
  const readItem = async (filePath) => {
    let head;
    let sizeMB;
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const st = await fh.stat();
        sizeMB = st.size / (1024 * 1024);
        // session_meta is line 0. Grow the read until we have a COMPLETE first
        // line (so a large meta record is not clipped mid-line and the session
        // silently dropped), or hit a hard cap. Common case reads 64KB once:
        // meta and the first prompt sit well within it and a newline is present.
        let readLen = Math.min(65536, st.size);
        const CAP = Math.min(2 * 1024 * 1024, st.size);
        for (;;) {
          const buf = Buffer.alloc(readLen);
          await fh.read(buf, 0, readLen, 0);
          head = buf.toString('utf8');
          if (head.indexOf('\n') !== -1 || readLen >= CAP) break;
          readLen = Math.min(readLen * 4, CAP);
        }
      } finally { await fh.close(); }
    } catch { return null; }
    const id = sessionIdFromFilename(path.basename(filePath));
    const parsed = parseCodexSessionHead(head, { indexTitle: index.get(id) });
    if (!parsed || !parsed.sessionId) return null;
    const projectPath = parsed.cwd || '';
    return {
      sessionId: parsed.sessionId,
      projectPath,
      projectName: projectPath ? projectPath.split('/').filter(Boolean).pop() : 'codex',
      preview: parsed.preview || 'Codex session',
      timestamp: parsed.timestamp || 0,
      age: (timeAgo && parsed.timestamp) ? timeAgo(parsed.timestamp) : 'unknown',
      status: 'done',
      sizeMB,
      isExec: parsed.isExec,
      source: 'codex',
    };
  };

  // Walk newest-first and read heads AS WE GO, stopping as soon as we have
  // `limit` matching sessions. Interactive sessions are rare here (the newest
  // thousands of files are all headless `codex exec` reviews), so a plain
  // newest-N window buried them. hardFileCap bounds the worst case when the
  // user is genuinely deep in exec history. Reads run in small batches so a
  // day's worth of files parses in parallel without opening thousands of fds.
  const kept = [];
  let filesRead = 0;
  const BATCH = 24;
  let batch = [];
  const drain = async () => {
    const results = await Promise.all(batch.map(readItem));
    batch = [];
    for (const it of results) {
      if (!it) continue;
      if (it.isExec && !includeExec) continue;
      if (projectFilter && it.projectPath !== projectFilter) continue;
      // Skip user-hidden projects DURING the walk, not after the limit is
      // applied: filtering after listCodexSessions returned its newest N let a
      // page full of hidden sessions consume the whole cap and hide the visible
      // ones (reviewer P2). An explicit projectFilter bypasses hide, matching
      // the Claude scan.
      if (!projectFilter && excludePaths && it.projectPath && excludePaths.has(it.projectPath)) continue;
      const { isExec: _isExec, ...item } = it;
      kept.push(item);
    }
  };
  outer:
  for (const y of await descNums(root)) {
    for (const m of await descNums(path.join(root, y))) {
      for (const d of await descNums(path.join(root, y, m))) {
        const dayDir = path.join(root, y, m, d);
        let names;
        try { names = (await fs.readdir(dayDir)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
        names.sort().reverse();
        for (const n of names) {
          batch.push(path.join(dayDir, n));
          filesRead += 1;
          if (batch.length >= BATCH) { await drain(); if (kept.length >= limit || filesRead >= hardFileCap) break outer; }
        }
      }
    }
  }
  if (batch.length) await drain();
  kept.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return kept.slice(0, limit);
}

export async function readSessionIndex(indexPath = path.join(CODEX_HOME(), 'session_index.jsonl')) {
  const out = new Map();
  let raw;
  try { raw = await fs.readFile(indexPath, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d && typeof d.id === 'string' && typeof d.thread_name === 'string') out.set(d.id, d.thread_name);
    } catch { /* skip a bad line */ }
  }
  return out;
}

/**
 * Parse a Codex rollout into {role, content} entries for the transcript view,
 * matching the Claude loadTranscript shape the mobile ChatView renders. Finds
 * the file by uuid with a bounded newest-first walk (the tapped session is
 * recent), then reads message records: response_item payload.type 'message'
 * (role user|assistant, content [{type,text}]) and event_msg user/agent
 * messages. Injected preambles are dropped so the reader sees the real chat.
 *
 * @param {string} sessionId  the rollout uuid
 * @param {{ limit?: number, maxFilesSearched?: number }} [opts]
 */
export async function codexTranscript(sessionId, { limit = 0, maxFilesSearched = 12000 } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-f-]{8,}$/i.test(sessionId)) return [];
  const root = CODEX_SESSIONS_DIR();
  const descNums = async (dir) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
    return ents.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name).sort((a, b) => Number(b) - Number(a));
  };
  let filePath = null;
  let searched = 0;
  outer:
  for (const y of await descNums(root)) {
    for (const m of await descNums(path.join(root, y))) {
      for (const d of await descNums(path.join(root, y, m))) {
        const dayDir = path.join(root, y, m, d);
        let names;
        try { names = (await fs.readdir(dayDir)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
        // Search newest-first WITHIN the day, matching listCodexSessions'
        // ordering. Without this the transcript walk searched raw readdir order
        // while the listing searched newest-first, so on a day with more than
        // maxFilesSearched rollouts a session that LISTS could still return an
        // empty transcript when its file sorted past the cap (reviewer P2).
        names.sort().reverse();
        for (const n of names) {
          searched += 1;
          if (sessionIdFromFilename(n) === sessionId) { filePath = path.join(dayDir, n); break outer; }
          if (searched >= maxFilesSearched) break outer;
        }
      }
    }
  }
  if (!filePath) return [];

  // Parse the message records out of a raw chunk into transcript entries,
  // keeping the NEWEST within budget. A positive limit keeps the last N; no
  // limit keeps a rolling ~12MB tail by bytes. Trimming from the front (not
  // breaking) matters because the read is a tail: breaking early would hide the
  // most recent turns the transcript view exists to show.
  // Turn one raw JSONL line into a transcript entry, or null. Pure.
  const entryFromLine = (line) => {
    if (!line.trim()) return null;
    let rec;
    try { rec = JSON.parse(line); } catch { return null; }
    // JSON.parse can yield null / a number / a string / an array. Guard before
    // property access so a literal `null` line does not throw (which would abort
    // the whole read and blank an otherwise valid transcript). Reviewer P1.
    if (!rec || typeof rec !== 'object') return null;
    const pl = rec.payload || {};
    let role = null;
    let text = '';
    if (rec.type === 'response_item' && pl.type === 'message' && (pl.role === 'user' || pl.role === 'assistant')) {
      role = pl.role; text = textFromContent(pl.content);
    } else if (rec.type === 'event_msg' && pl.type === 'user_message') {
      role = 'user'; text = typeof pl.message === 'string' ? pl.message : '';
    } else if (rec.type === 'event_msg' && pl.type === 'agent_message') {
      role = 'assistant'; text = typeof pl.message === 'string' ? pl.message : '';
    }
    if (!role) return null;
    const raw = String(text);
    text = raw.trim();
    if (!text) return null;
    if (role === 'user' && looksInjected(text)) return null; // drop AGENTS.md/env preamble
    if (text.length > 20000) text = text.slice(0, 20000);
    // V8's String.trim and String.slice can return a SlicedString that keeps the
    // FULL parent alive: 8MB of leading spaces trimmed to 24 chars, or a 20000-
    // char preview of an 8MB record, both retain all 8MB, so a run of such
    // records exhausts the heap (reviewer P2). Detach whenever the parent is
    // more than DOUBLE the kept text: that bounds retained backing to <= 2x the
    // kept content per entry (so the whole transcript's retained backing stays
    // <= 2x its output), with no absolute-threshold hole where many
    // just-under-threshold trims accumulate. Copy through utf16le, not the
    // default utf8: a utf8 round-trip replaces a lone surrogate (valid in a JSON
    // string) with U+FFFD and corrupts the preview; utf16le is a lossless
    // code-unit copy. Normal messages (kept ~= original) skip the copy.
    if (raw.length > text.length * 2) text = Buffer.from(text, 'utf16le').toString('utf16le');
    return { role, content: text };
  };

  // STREAM the rollout line by line, keeping the newest within budget. Streaming
  // (not a head/tail byte window) is what makes a message SANDWICHED between two
  // records larger than any byte cap still parse: each complete line is handled
  // wherever it sits, so the real prompt between two 129MB tool outputs is found
  // (reviewer P1). A positive limit keeps the last N entries; no limit keeps a
  // rolling ~12MB tail by content bytes.
  //
  // We do NOT use readline: it assembles a whole line before emitting, so a
  // single record past V8's ~512MB string limit throws RangeError from inside
  // its internals, outside this Promise's handlers, and Dobius's
  // uncaught-exception handler then EXITS the app (reviewer P1). Instead, split
  // on newlines manually and CAP the in-progress line at MAX_LINE: a record
  // larger than that is skipped (it cannot be displayed anyway, text is capped
  // to 20000 chars) rather than crashing, and every other record still parses.
  // indexOf runs on each bounded chunk, so cost stays O(file size), not O(n^2).
  const MAX_LINE = 64 * 1024 * 1024; // well under V8's string-length limit
  const entries = [];
  let bytes = 0;
  const push = (e) => {
    entries.push(e);
    if (typeof limit === 'number' && limit > 0) {
      if (entries.length > limit) entries.shift();
    } else {
      bytes += e.content.length;
      while (bytes > 12 * 1024 * 1024 && entries.length > 1) {
        bytes -= entries[0].content.length;
        entries.shift();
      }
    }
  };
  let pending = '';
  let skipping = false; // inside a line that already exceeded MAX_LINE
  const onChunk = (chunk) => {
    let start = 0;
    if (skipping) {
      const nl = chunk.indexOf('\n');
      if (nl === -1) return; // still inside the oversized line
      skipping = false; pending = ''; start = nl + 1;
    }
    let nl;
    while ((nl = chunk.indexOf('\n', start)) !== -1) {
      // Honor MAX_LINE on the COMPLETING path too: a line whose terminating
      // newline lands in this chunk must not be assembled if pending plus its
      // final segment exceeds the cap, or a 64MB-plus record would slip past the
      // skip that the incomplete-line path enforces (reviewer P3). Keeps the
      // built string bounded and consistent with the skip behavior.
      if (pending.length + (nl - start) > MAX_LINE) {
        pending = '';
        start = nl + 1;
        continue;
      }
      const e = entryFromLine(pending + chunk.slice(start, nl));
      pending = '';
      if (e) push(e);
      start = nl + 1;
    }
    pending += chunk.slice(start);
    if (pending.length > MAX_LINE) { pending = ''; skipping = true; } // drop the giant record
  };
  try {
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, { encoding: 'utf8' });
      stream.on('error', reject);
      // Route ANY throw from the chunk splitter into the Promise (and close the
      // stream) so it can never escape to the process uncaught-exception handler,
      // which would exit the app. The splitter is written not to throw (line size
      // is capped below V8's string limit), but this makes that guarantee
      // enforced rather than assumed (reviewer P1 on the readline version).
      stream.on('data', (chunk) => {
        try { onChunk(chunk); }
        catch (err) { stream.destroy(); reject(err); }
      });
      stream.on('close', () => {
        try {
          if (!skipping && pending) { const e = entryFromLine(pending); if (e) push(e); }
          resolve();
        } catch (err) { reject(err); }
      });
    });
  } catch { return []; }
  return entries;
}

// "What's new" notes: one Markdown file per release, electron/whats-new/<version>.md, a few "- " lines in plain
// words. Pure (no Electron) so release.sh checks a file with the SAME rules the app reads it with: a release whose
// notes the app would refuse never starts (Codex design review, finding 10).
//
// The folder is under electron/ on purpose: it is bundled with the app (electron/** in electron-builder.yml) and it is
// NOT one of the iOS release's app paths, so desktop notes never trigger a phone build (finding 9).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'whats-new');
export const MAX_BYTES = 4096;
export const MAX_BULLETS = 5;
export const MAX_LINE = 280;
export const MAX_SECTIONS = 10; // every skipped release up to ten, newest first (the popup body scrolls)
const VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
// En and em dash, built from their codes (house rule: neither appears in user-facing text).
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
// C0 controls, DEL, line/paragraph separators and the bidi overrides and isolates.
const CONTROLS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`
  + `${String.fromCharCode(0x2028, 0x2029)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`);

export function isVersion(v) { return typeof v === 'string' && VERSION_RE.test(v); }

// -1, 0 or 1. Callers validate with isVersion first.
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// { ok: true, bullets } or { ok: false, error }. Every non-blank line must be a "- " bullet; anything else (a heading,
// a stray paragraph) is refused rather than silently dropped, so what the author wrote is what people see.
export function parseNotes(text) {
  if (typeof text !== 'string') return { ok: false, error: 'not text' };
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { ok: false, error: `longer than ${MAX_BYTES} bytes` };
  const bullets = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('- ')) return { ok: false, error: `not a "- " line: ${line.slice(0, 60)}` };
    const t = line.slice(2).trim();
    if (!t) return { ok: false, error: 'an empty bullet' };
    if (t.length > MAX_LINE) return { ok: false, error: `a line longer than ${MAX_LINE} characters` };
    if (DASHES.test(t)) return { ok: false, error: 'a dash character (use a comma, colon or period)' };
    if (CONTROLS.test(t)) return { ok: false, error: 'a control character' };
    bullets.push(t);
  }
  if (bullets.length === 0) return { ok: false, error: 'no "- " lines' };
  if (bullets.length > MAX_BULLETS) return { ok: false, error: `more than ${MAX_BULLETS} lines` };
  return { ok: true, bullets };
}

// The versions that have a notes file, each read and parsed once. Bad files are skipped (and named in `bad`).
export function readAllNotes(dir = NOTES_DIR) {
  const notes = new Map();
  const bad = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { bad.push(`folder: ${err.code || err.message}`); return { notes, bad }; }
  for (const name of names) {
    const m = /^(.+)\.md$/.exec(name);
    if (!m || !isVersion(m[1])) continue;
    let text;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).size > MAX_BYTES) { bad.push(`${name}: too large`); continue; }
      text = fs.readFileSync(file, 'utf8');
    } catch (err) { bad.push(`${name}: ${err.code || err.message}`); continue; }
    const p = parseNotes(text);
    if (p.ok) notes.set(m[1], p.bullets); else bad.push(`${name}: ${p.error}`);
  }
  return { notes, bad };
}

// What to show and what to record, from the saved state alone.
//   seen: the highest version whose notes were dismissed (or null)
//   existedAtStart: config.json was there before this launch (an install that ran before)
// -> { sections: [{ version, bullets }], newSeen }   newSeen null = write nothing
// Never lowers `seen` (a downgrade and back must not re-show notes already read, finding 6).
export function plan({ current, seen, existedAtStart, notes }) {
  if (!isVersion(current)) return { sections: [], newSeen: null };
  const seenOk = isVersion(seen) ? seen : null;
  if (seenOk && compareVersions(seenOk, current) >= 0) return { sections: [], newSeen: null };
  // Fresh install: nothing to tell them about, start counting from here.
  if (!seenOk && !existedAtStart) return { sections: [], newSeen: current };
  // No `seen` on an install that ran before means it last ran a version older than the popup itself, so every notes
  // file up to this one was missed (Sam, 2026-11-12: going 2.2.25 to 2.2.28 should show 2.2.28, 2.2.27 and 2.2.26).
  const versions = [...notes.keys()]
    .filter((v) => compareVersions(v, current) <= 0 && (!seenOk || compareVersions(v, seenOk) > 0))
    .sort((a, b) => compareVersions(b, a))
    .slice(0, MAX_SECTIONS);
  if (versions.length === 0) return { sections: [], newSeen: current };
  return { sections: versions.map((version) => ({ version, bullets: notes.get(version) })), newSeen: null };
}

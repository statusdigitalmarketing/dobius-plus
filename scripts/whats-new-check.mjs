#!/usr/bin/env node
// release.sh preflight: the release about to be made must have its What's new notes, written for people and valid
// by the SAME rules the app reads them with (electron/whats-new-notes.js). Runs before the version bump, so a missing
// or bad file stops the release while nothing is public yet.
//
// Usage: node scripts/whats-new-check.mjs <patch|minor|major>   prints the version it checked, exits 1 when not ready
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTES_DIR, parseNotes, isVersion } from '../electron/whats-new-notes.js';

export function nextVersion(current, bump) {
  if (!isVersion(current)) throw new Error(`package.json version is not x.y.z: ${current}`);
  const [a, b, c] = current.split('.').map(Number);
  if (bump === 'patch') return `${a}.${b}.${c + 1}`;
  if (bump === 'minor') return `${a}.${b + 1}.0`;
  if (bump === 'major') return `${a + 1}.0.0`;
  throw new Error(`bump must be patch, minor or major: ${bump}`);
}

export function checkNotes(version, dir = NOTES_DIR) {
  const file = path.join(dir, `${version}.md`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    return { ok: false, error: `no notes for ${version}: write ${path.relative(process.cwd(), file)} (2 to 5 "- " lines in plain words) and commit it` };
  }
  const p = parseNotes(text);
  if (!p.ok) return { ok: false, error: `${path.basename(file)}: ${p.error}` };
  // The same notes show in Updates and What's new on Windows (Max, 2026-11-13): name the machine as "this computer".
  // Read as it renders: markdown marks and entities dropped, any run of spaces one space.
  const rendered = (b) => b.replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').replace(/<[^>]*>|[*_`~\\]/g, '').replace(/\s+/g, ' ');
  const mac = p.bullets.find((b) => /\bthis Mac\b/i.test(rendered(b)));
  if (mac) return { ok: false, error: `${path.basename(file)}: say "this computer", not "this Mac" (the notes show on Windows too): ${mac}` };
  return { ok: true, bullets: p.bullets };
}

function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const v = nextVersion(current, process.argv[2] || 'patch');
  const r = checkNotes(v);
  if (!r.ok) { console.error(`ERROR: ${r.error}`); process.exit(1); }
  console.log(v);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

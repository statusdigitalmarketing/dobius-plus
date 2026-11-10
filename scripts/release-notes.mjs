#!/usr/bin/env node
// Release notes for a tag: one line per change since the previous tag, read from commit subjects.
// 2026-11-10: every release after v2.1.7 went out with an empty body, so Settings > Updates said
// "(no release notes)" (Max, Windows 2.2.17 pass). release.sh sets this as the body before publishing.
//
// Usage: node scripts/release-notes.mjs <tag>      (prints Markdown to stdout)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Subjects that are bookkeeping, not changes a user would notice: the version bump, and notes-to-self commits.
const SKIP = [/^v?\d+\.\d+\.\d+$/, /^(LESSONS|NOTES)\b/i]; // merges are left out by git log --no-merges
const MAX_LINES = 60; // GitHub caps the body at 125k chars and the panel shows 20k; 60 lines is a release

export function notesFromSubjects(subjects) {
  const seen = new Set();
  const lines = [];
  for (const raw of subjects) {
    const s = raw.replace(/\.?\s*WIP:.*$/, '').trim(); // "WIP: Codex pending" was true of the commit, not the release
    if (!s || SKIP.some((re) => re.test(s)) || seen.has(s)) continue;
    seen.add(s);
    lines.push(`- ${s}`);
  }
  if (lines.length === 0) return 'Maintenance release.\n';
  const extra = lines.length - MAX_LINES;
  const kept = extra > 0 ? [...lines.slice(0, MAX_LINES), `- and ${extra} more`] : lines;
  return `${kept.join('\n')}\n`;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}

function main() {
  const tag = process.argv[2];
  if (!tag) {
    console.error('usage: node scripts/release-notes.mjs <tag>');
    process.exit(2);
  }
  let prev = '';
  try {
    prev = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`]);
  } catch (err) {
    console.error(`release-notes: no earlier tag before ${tag} (${err.message.split('\n')[0]}), listing the last 30 commits`);
  }
  const range = prev ? [`${prev}..${tag}`] : ['-n', '30', tag];
  const subjects = git(['log', '--no-merges', '--format=%s', ...range]).split('\n');
  process.stdout.write(notesFromSubjects(subjects));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

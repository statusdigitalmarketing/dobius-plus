// Account profiles share ONE setup (v1.0.66). These lock the two things that
// matter: a profile ends up resolving to ~/.claude, and NOTHING is ever lost
// on the way there. Losing a transcript to a merge would be unrecoverable.
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SHARED_ENTRIES, shareProfile, shareEntry, mergeInto, linksTo, shareConfiguredProfiles,
  countCollisions,
} from '../account-profile-share.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

// The credential must NEVER be shared: .claude.json holds oauthAccount and the
// Keychain entry is keyed by config dir, so sharing it would collapse every
// account back into one login and make switching cosmetic again.
check('the credential file is not in the shared set',
  SHARED_ENTRIES.includes('.claude.json'), false);
check('per-process runtime state is not shared',
  SHARED_ENTRIES.some((e) => ['sessions', 'shell-snapshots', 'statsig', 'cache'].includes(e)), false);
check('transcripts and the session index ARE shared',
  SHARED_ENTRIES.includes('projects') && SHARED_ENTRIES.includes('history.jsonl'), true);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-share-'));
const DEF = path.join(tmp, 'claude');
const ROOT = path.join(tmp, 'profiles');
const opts = (extra = {}) => ({ defaultDir: DEF, profilesRoot: ROOT, stamp: 1, ...extra });
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// A realistic default dir: transcripts, a session index, the workflow layer.
write(path.join(DEF, 'projects', '-proj-a', 'sessA.jsonl'), 'A');
write(path.join(DEF, 'history.jsonl'), 'default-history\n');
write(path.join(DEF, 'CLAUDE.md'), '# rules');
write(path.join(DEF, 'skills', 'gmail', 'SKILL.md'), 'skill');

// --- fresh profile: everything present in default gets linked -------------
const P1 = path.join(ROOT, 'acct-1');
const r1 = shareProfile(P1, opts());
check('fresh profile links the transcripts dir', r1.projects, 'linked');
check('fresh profile links the session index', r1['history.jsonl'], 'linked');
check('fresh profile links the global CLAUDE.md', r1['CLAUDE.md'], 'linked');
check('entries absent from ~/.claude are left alone, not linked to nothing',
  r1['stats-cache.json'], 'absent-in-default');
check('no dangling link created for an absent entry',
  fs.existsSync(path.join(P1, 'stats-cache.json')), false);
check('a session in ~/.claude is now readable through the profile',
  fs.readFileSync(path.join(P1, 'projects', '-proj-a', 'sessA.jsonl'), 'utf8'), 'A');

// --- idempotent -----------------------------------------------------------
const r1b = shareProfile(P1, opts());
check('re-running is a no-op', r1b.projects, 'already-shared');

// --- the real migration: profile already holds its own transcripts ---------
const P2 = path.join(ROOT, 'acct-2');
write(path.join(P2, 'projects', '-proj-b', 'sessB.jsonl'), 'B');
write(path.join(P2, 'projects', '-proj-a', 'sessC.jsonl'), 'C');
const r2 = shareProfile(P2, opts());
check('a profile with its own transcripts is merged, then linked', r2.projects, 'merged');
check('a transcript in a project the shared store did not have survives',
  fs.readFileSync(path.join(DEF, 'projects', '-proj-b', 'sessB.jsonl'), 'utf8'), 'B');
check('a transcript merged INTO an existing shared project survives',
  fs.readFileSync(path.join(DEF, 'projects', '-proj-a', 'sessC.jsonl'), 'utf8'), 'C');
check('the pre-existing shared transcript is untouched',
  fs.readFileSync(path.join(DEF, 'projects', '-proj-a', 'sessA.jsonl'), 'utf8'), 'A');
check('the profile now resolves to the shared store',
  linksTo(path.join(P2, 'projects'), path.join(DEF, 'projects')), true);

// --- collision: never clobber, never move a dir out from under a live write -
const P3 = path.join(ROOT, 'acct-3');
write(path.join(P3, 'projects', '-proj-a', 'sessA.jsonl'), 'DIFFERENT');
write(path.join(P3, 'projects', '-proj-z', 'sessZ.jsonl'), 'Z');
const r3 = shareProfile(P3, opts({ stamp: 7 }));
check('a collision leaves the profile dir alone rather than linking', r3.projects, 'kept-not-shared');
check('the shared copy wins and is not overwritten',
  fs.readFileSync(path.join(DEF, 'projects', '-proj-a', 'sessA.jsonl'), 'utf8'), 'A');
check('the colliding profile copy stays exactly where a live writer left it',
  fs.readFileSync(path.join(P3, 'projects', '-proj-a', 'sessA.jsonl'), 'utf8'), 'DIFFERENT');
// All or nothing. A partial merge would move sessZ into the shared store and
// leave the profile a real dir, so sessZ would be unreachable from THIS
// account: the exact bug this module exists to remove.
check('a non-colliding sibling is NOT moved out from under the profile',
  fs.readFileSync(path.join(P3, 'projects', '-proj-z', 'sessZ.jsonl'), 'utf8'), 'Z');
check('and it did not leak into the shared store either',
  fs.existsSync(path.join(DEF, 'projects', '-proj-z')), false);
check('every session the profile had is still reachable through the profile path',
  fs.readdirSync(path.join(P3, 'projects')).sort().join(','), '-proj-a,-proj-z');
check('and no symlink was created over the kept directory',
  fs.lstatSync(path.join(P3, 'projects')).isSymbolicLink(), false);

// countCollisions must never touch the filesystem.
const beforeScan = fs.readdirSync(path.join(P3, 'projects')).sort().join(',');
check('countCollisions finds the clash', countCollisions(path.join(P3, 'projects'), path.join(DEF, 'projects')), 1);
check('and moves nothing while doing it',
  fs.readdirSync(path.join(P3, 'projects')).sort().join(','), beforeScan);

// --- a real file is preserved, never blind-merged -------------------------
const P4 = path.join(ROOT, 'acct-4');
write(path.join(P4, 'history.jsonl'), 'profile-history\n');
const r4 = shareProfile(P4, opts({ stamp: 9 }));
check("a profile's own session index is set aside", r4['history.jsonl'], 'preserved-and-linked');
check('its contents are recoverable',
  fs.readFileSync(path.join(P4, 'history.jsonl.pre-share-9'), 'utf8'), 'profile-history\n');
check('and the shared index is what the CLI now reads',
  fs.readFileSync(path.join(P4, 'history.jsonl'), 'utf8'), 'default-history\n');

// --- a link someone else pointed elsewhere is not rewritten ---------------
const P5 = path.join(ROOT, 'acct-5');
const elsewhere = path.join(tmp, 'elsewhere');
fs.mkdirSync(elsewhere, { recursive: true });
fs.mkdirSync(P5, { recursive: true });
fs.symlinkSync(elsewhere, path.join(P5, 'projects'));
check('a foreign symlink is left alone', shareProfile(P5, opts()).projects, 'foreign-symlink');

// --- a profile dir that is really a symlink INTO ~/.claude -----------------
// The catastrophic case: lexical guards pass, so every entry would be renamed
// aside and linked to itself, making all transcripts ELOOP.
const P6 = path.join(ROOT, 'acct-loop');
fs.symlinkSync(DEF, P6);
check('a profile symlinked at the default dir is refused',
  shareProfile(P6, opts()), { skipped: 'profile-is-default-dir' });
check('the real transcripts dir was NOT renamed aside',
  fs.readFileSync(path.join(DEF, 'projects', '-proj-a', 'sessA.jsonl'), 'utf8'), 'A');
check('and projects is still a real directory, not a self-referential link',
  fs.lstatSync(path.join(DEF, 'projects')).isSymbolicLink(), false);

// A profile symlinked somewhere else entirely is also out of bounds.
const P7 = path.join(ROOT, 'acct-out');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(outside, { recursive: true });
fs.symlinkSync(outside, P7);
check('a profile symlinked outside the profiles root is refused',
  shareProfile(P7, opts()), { skipped: 'outside-profiles-root' });

// shareEntry called directly on two names for one directory must not act.
check('shareEntry refuses when link and target are the same directory',
  shareEntry(DEF, DEF, 'projects'), 'same-as-target');

// --- setting a file aside twice must not overwrite the first one ----------
const P8 = path.join(ROOT, 'acct-aside');
write(path.join(P8, 'history.jsonl'), 'FIRST\n');
shareProfile(P8, opts({ stamp: 5 }));
fs.unlinkSync(path.join(P8, 'history.jsonl'));
write(path.join(P8, 'history.jsonl'), 'SECOND\n');
shareProfile(P8, opts({ stamp: 5 }));
check('the first preserved copy survives a second run at the same stamp',
  fs.readFileSync(path.join(P8, 'history.jsonl.pre-share-5'), 'utf8'), 'FIRST\n');
check('and the second is preserved under a distinct name',
  fs.readFileSync(path.join(P8, 'history.jsonl.pre-share-5-1'), 'utf8'), 'SECOND\n');

// --- a broken link is a bug, not a preference -----------------------------
const P9 = path.join(ROOT, 'acct-dangling');
fs.mkdirSync(P9, { recursive: true });
fs.symlinkSync(path.join(tmp, 'gone-forever'), path.join(P9, 'projects'));
check('a dangling symlink is repaired', shareProfile(P9, opts()).projects, 'relinked-dangling');
check('and now resolves to the shared store',
  linksTo(path.join(P9, 'projects'), path.join(DEF, 'projects')), true);

// --- a residue that cannot move must not split the store -------------------
// Pre-scan finds no clash, but the move fails (here: a read-only source dir).
// Leaving the residue behind would hide the already-moved entries from this
// profile AND the residue from the shared store.
const P10 = path.join(ROOT, 'acct-residual');
write(path.join(P10, 'projects', '-proj-r', 'sessR.jsonl'), 'R');
fs.chmodSync(path.join(P10, 'projects'), 0o555);
const r10 = shareProfile(P10, opts({ stamp: 3 }));
fs.chmodSync(path.join(P10, 'projects.pre-share-3'), 0o755);
check('an unmovable residue is set aside, not left to split the store',
  r10.projects, 'partial-merge-set-aside');
check('the profile still ends up resolving to the one shared store',
  linksTo(path.join(P10, 'projects'), path.join(DEF, 'projects')), true);
check('and the residue is preserved, not deleted',
  fs.readFileSync(path.join(P10, 'projects.pre-share-3', '-proj-r', 'sessR.jsonl'), 'utf8'), 'R');

// --- a drained subdirectory that refuses to go must still count ------------
// mergeInto used to return 0 here, so the caller believed the merge was
// complete and tried to symlink over a populated directory.
const P11 = path.join(ROOT, 'acct-nested');
write(path.join(P11, 'projects', '-proj-n', 'sessN.jsonl'), 'N');
fs.mkdirSync(path.join(DEF, 'projects', '-proj-n'), { recursive: true });
fs.chmodSync(path.join(P11, 'projects'), 0o555); // children can move, the dir cannot be removed
const r11 = shareProfile(P11, opts({ stamp: 4 }));
fs.chmodSync(path.join(P11, 'projects.pre-share-4'), 0o755);
check('an undeletable drained subdir is reported, not silently treated as empty',
  r11.projects, 'partial-merge-set-aside');
check('the transcript itself reached the shared store',
  fs.readFileSync(path.join(DEF, 'projects', '-proj-n', 'sessN.jsonl'), 'utf8'), 'N');
check('and the profile resolves to that store rather than a split tree',
  linksTo(path.join(P11, 'projects'), path.join(DEF, 'projects')), true);

// --- guards ---------------------------------------------------------------
check('refuses to touch the default dir itself',
  shareProfile(DEF, opts()), { skipped: 'is-default-dir' });
check('refuses a path outside the profiles root',
  shareProfile(path.join(tmp, 'random'), opts()), { skipped: 'outside-profiles-root' });
check('refuses an empty path', shareProfile('', opts()), { skipped: 'no-path' });
check('no-ops when there is no ~/.claude to share',
  shareProfile(path.join(ROOT, 'acct-9'), opts({ defaultDir: path.join(tmp, 'nope') })),
  { skipped: 'no-default-dir' });

// --- account list plumbing ------------------------------------------------
const out = shareConfiguredProfiles([
  { id: 'a', name: 'A', type: 'claude', claudeJsonPath: path.join(ROOT, 'acct-6', '.claude.json') },
  { id: 'b', name: 'B', type: 'codex', apiKey: 'x' },
  { id: 'c', name: 'C', type: 'claude' },
  null,
], opts());
check('only claude accounts with a profile path are shared', out.length, 1);
check('the account profile got linked', out[0].report.projects, 'linked');
check('shareConfiguredProfiles tolerates a non-array', shareConfiguredProfiles(null, opts()), []);

// --- mergeInto leaves an empty source behind ------------------------------
const mSrc = path.join(tmp, 'msrc'), mDst = path.join(tmp, 'mdst');
write(path.join(mSrc, 'x', 'f.txt'), 'f');
check('mergeInto reports nothing left behind on a clean merge', mergeInto(mSrc, mDst), 0);
check('mergeInto moved the nested file', fs.readFileSync(path.join(mDst, 'x', 'f.txt'), 'utf8'), 'f');

// --- shareEntry is safe to call for a name default does not have ----------
check('shareEntry on an unknown name is inert',
  shareEntry(P1, DEF, 'does-not-exist'), 'absent-in-default');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);

// What's new after an update: the notes rules (shared with release.sh), what to show for which saved state, and main's
// choice of window (one at a time, focused and listening, only after the restore).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-whatsnew-'));
// An install that ran before: config.json exists before config-manager loads.
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ projects: {}, settings: {} }));
process.env.DOBIUS_TEST_USERDATA = userData;
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const notesMod = await import('../whats-new-notes.js');
const { parseNotes, plan, compareVersions, readAllNotes, NOTES_DIR } = notesMod;

test('parseNotes: plain "- " lines only, 1 to 5, no dashes or controls', () => {
  assert.deepEqual(parseNotes('- one\n\n- two\n'), { ok: true, bullets: ['one', 'two'] });
  assert.equal(parseNotes('').ok, false);
  assert.equal(parseNotes('- \n').ok, false);
  assert.equal(parseNotes('# Heading\n- one').ok, false);
  assert.equal(parseNotes('- a\n- b\n- c\n- d\n- e\n- f').ok, false);
  assert.equal(parseNotes(`- ${'x'.repeat(281)}`).ok, false);
  assert.equal(parseNotes(`- a ${String.fromCharCode(0x2014)} b`).ok, false);
  assert.equal(parseNotes(`- a${String.fromCharCode(0x202e)}b`).ok, false);
  assert.equal(parseNotes(`- ${'y'.repeat(4097)}`).ok, false);
});

test('every shipped notes file passes the rules', () => {
  const { notes, bad } = readAllNotes(NOTES_DIR);
  assert.deepEqual(bad, []);
  assert.ok(notes.size >= 1);
});

test('compareVersions orders numerically', () => {
  assert.equal(compareVersions('2.2.9', '2.2.10'), -1);
  assert.equal(compareVersions('2.3.0', '2.2.99'), 1);
  assert.equal(compareVersions('2.2.26', '2.2.26'), 0);
});

const N = new Map([['2.2.24', ['a']], ['2.2.26', ['b']], ['2.2.27', ['c']], ['2.2.28', ['d']], ['2.2.29', ['e']], ['2.2.30', ['f']]]);

test('plan: fresh install shows nothing and starts counting', () => {
  assert.deepEqual(plan({ current: '2.2.26', seen: null, existedAtStart: false, notes: N }), { sections: [], newSeen: '2.2.26' });
});

test('plan: updating from a version before the popup shows every release up to this one', () => {
  const p = plan({ current: '2.2.28', seen: null, existedAtStart: true, notes: N });
  assert.deepEqual(p.sections.map((s) => s.version), ['2.2.28', '2.2.27', '2.2.26', '2.2.24']);
  assert.equal(p.newSeen, null);
});

test('plan: skipped releases, newest first, none past the running version', () => {
  const p = plan({ current: '2.2.29', seen: '2.2.24', existedAtStart: true, notes: N });
  assert.deepEqual(p.sections.map((s) => s.version), ['2.2.29', '2.2.28', '2.2.27', '2.2.26']);
});

test('plan: a long skip is capped at the newest MAX_SECTIONS', () => {
  const many = new Map(Array.from({ length: 15 }, (_, i) => [`3.0.${i}`, ['x']]));
  const p = plan({ current: '3.0.14', seen: '2.9.0', existedAtStart: true, notes: many });
  assert.equal(p.sections.length, notesMod.MAX_SECTIONS);
  assert.equal(p.sections[0].version, '3.0.14');
  assert.equal(p.sections.at(-1).version, `3.0.${15 - notesMod.MAX_SECTIONS}`);
});

test('plan: already seen, or a downgrade, writes nothing (never lowers seen)', () => {
  assert.deepEqual(plan({ current: '2.2.26', seen: '2.2.26', existedAtStart: true, notes: N }), { sections: [], newSeen: null });
  assert.deepEqual(plan({ current: '2.2.26', seen: '2.2.30', existedAtStart: true, notes: N }), { sections: [], newSeen: null });
});

test('plan: an update with no notes records it as seen', () => {
  assert.deepEqual(plan({ current: '2.2.25', seen: '2.2.24', existedAtStart: true, notes: N }), { sections: [], newSeen: '2.2.25' });
});

test('release check: next version and its notes', async () => {
  const { nextVersion, checkNotes } = await import('../../scripts/whats-new-check.mjs');
  assert.equal(nextVersion('2.2.25', 'patch'), '2.2.26');
  assert.equal(nextVersion('2.2.25', 'minor'), '2.3.0');
  assert.equal(nextVersion('2.2.25', 'major'), '3.0.0');
  assert.throws(() => nextVersion('2.2.25', 'nope'));
  assert.equal(checkNotes('2.2.26').ok, true);
  assert.equal(checkNotes('9.9.9').ok, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-wn-notes-'));
  fs.writeFileSync(path.join(dir, '1.0.1.md'), '- \n');
  assert.equal(checkNotes('1.0.1', dir).ok, false);
  fs.writeFileSync(path.join(dir, '1.0.2.md'), '- A phone turned away by this Mac is now logged.\n');
  assert.match(checkNotes('1.0.2', dir).error, /this computer/);
  fs.writeFileSync(path.join(dir, '1.0.3.md'), '- A phone turned away by this computer is now logged.\n');
  assert.equal(checkNotes('1.0.3', dir).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('release body puts the notes first and falls back to commit subjects', async () => {
  const { whatsNewBody } = await import('../../scripts/release-notes.mjs');
  assert.match(whatsNewBody('2.2.26'), /^- After each update/);
  assert.equal(whatsNewBody('9.9.9'), '');
});

test('main: one focused, listening window at a time, only after the restore', async () => {
  const electron = await import('electron');
  const { app, ipcMain, BrowserWindow } = electron;
  const on = {};
  const appOn = {};
  ipcMain.on = (ch, fn) => { on[ch] = fn; };
  ipcMain.handle = (ch, fn) => { on[ch] = fn; };
  app.on = (ev, fn) => { appOn[ev] = fn; };
  app.getVersion = () => '2.2.26';
  app.isPackaged = true;
  let focused = null;
  BrowserWindow.getFocusedWindow = () => focused;
  const mk = (id) => {
    const wc = { id, sent: [], l: {}, send(ch, d) { this.sent.push([ch, d]); }, once(ev, fn) { this.l[ev] = fn; }, on(ev, fn) { this.l[ev] = fn; } };
    return { wc, win: { webContents: wc, isDestroyed: () => false } };
  };
  const { initWhatsNew, whatsNewRestoreDone } = await import('../whats-new.js');
  const { loadConfig } = await import('../config-manager.js');
  initWhatsNew();

  const A = mk(1);
  const B = mk(2);
  focused = A.win;
  on['whatsNew:ready']({ sender: A.wc });
  assert.equal(A.wc.sent.length, 0, 'nothing before the restore has finished');
  const D = mk(4); // focused but not listening yet (its page is still loading)
  focused = D.win;
  whatsNewRestoreDone();
  assert.equal(D.wc.sent.length, 0, 'a window that has not said it is listening gets nothing');
  assert.equal(A.wc.sent.length, 0, 'a window that is not focused gets nothing');
  focused = A.win;
  appOn['browser-window-focus']();
  assert.equal(A.wc.sent.length, 1);
  assert.equal(A.wc.sent[0][0], 'whatsNew:show');
  assert.deepEqual(A.wc.sent[0][1].sections.map((s) => s.version), ['2.2.26']);

  focused = B.win;
  on['whatsNew:ready']({ sender: B.wc });
  appOn['browser-window-focus']();
  assert.equal(B.wc.sent.length, 0, 'never two windows at once');

  on['whatsNew:dismiss']({ sender: B.wc });
  assert.equal(loadConfig().whatsNew, undefined, 'only the window showing it can dismiss it');

  A.wc.l.destroyed();
  assert.equal(B.wc.sent.length, 1, 'the focused listening window takes over when the first one closes');

  on['whatsNew:ready']({ sender: B.wc });
  assert.equal(B.wc.sent.length, 2, 'a reload of the focused window showing it shows it again');

  const E = mk(5);
  on['whatsNew:ready']({ sender: E.wc });
  focused = E.win;
  B.wc.l['did-navigate']();
  assert.equal(E.wc.sent.length, 1, 'a reload gives it up; the focused listening window gets it');
  on['whatsNew:ready']({ sender: B.wc });
  assert.equal(B.wc.sent.length, 2, 'the reloaded window, now behind, does not take it back');

  on['whatsNew:release']({ sender: B.wc }); // a window that only listened stops listening
  on['whatsNew:release']({ sender: E.wc }); // the one showing it gives it back
  assert.equal(E.wc.sent.length, 1, 'a window that released it is not offered it again until it says ready');
  focused = B.win;
  appOn['browser-window-focus']();
  assert.equal(B.wc.sent.length, 2, 'a window that stopped listening is not sent it');
  on['whatsNew:ready']({ sender: B.wc });
  assert.equal(B.wc.sent.length, 3, 'released: the next focused listening window shows it');

  on['whatsNew:dismiss']({ sender: B.wc });
  assert.deepEqual(loadConfig().whatsNew, { seen: '2.2.26' });

  const C = mk(3);
  focused = C.win;
  on['whatsNew:ready']({ sender: C.wc });
  appOn['browser-window-focus']();
  assert.equal(C.wc.sent.length, 0, 'once dismissed it is gone');

  assert.deepEqual(await on['whatsNew:current'](), { version: '2.2.26', bullets: readAllNotes(NOTES_DIR).notes.get('2.2.26') });
});

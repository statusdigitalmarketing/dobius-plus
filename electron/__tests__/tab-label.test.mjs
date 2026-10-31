// Automatic tab labels: title sanitizing, the length cap, ignoring shell/path
// titles, and the precedence rule (user > agent > title).
// Run: node ./electron/__tests__/tab-label.test.mjs
import assert from 'node:assert/strict';
import {
  cleanLabel, labelFromTitle, applyAutoLabel, lockLabel, unlockLabel, isLabelLocked, labelMeta, parseLabelMeta, MAX_TAB_LABEL,
  sessionNameFromTabLabel, MAX_SESSION_NAME,
} from '../../shared/tab-label.js';

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

// 1. Claude Code's status glyphs come off the front.
assert.equal(labelFromTitle('✳ Refactor auth flow'), 'Refactor auth flow');
assert.equal(labelFromTitle('⠂ Refactor auth flow'), 'Refactor auth flow');
assert.equal(labelFromTitle('⠐⠂ Fix login bug'), 'Fix login bug');
assert.equal(labelFromTitle('✻ Fix login bug'), 'Fix login bug');
assert.equal(labelFromTitle('· Fix login bug'), 'Fix login bug');
assert.equal(labelFromTitle('* Fix login bug'), 'Fix login bug');
assert.equal(labelFromTitle('Refactor auth flow'), 'Refactor auth flow');
ok('leading spinner and status glyphs are stripped');

// 2. Control characters and runs of whitespace never reach the tab bar.
assert.equal(cleanLabel('Fix\u0007 the\tbuild\n now'), 'Fix the build now');
assert.equal(cleanLabel('\u001b[31mred'), '[31mred');
assert.equal(cleanLabel('   '), '');
assert.equal(cleanLabel(42), '');
ok('control characters and whitespace are normalised');

// 3. Length cap with an ellipsis, never longer than the cap.
const long = 'Investigate the intermittent websocket reconnect failure on mobile';
const capped = labelFromTitle(long);
assert.ok(capped.length <= MAX_TAB_LABEL && capped.length >= MAX_TAB_LABEL - 2, capped);
assert.ok(capped.endsWith('…'));
assert.ok(long.startsWith(capped.slice(0, -1).trimEnd()));
assert.equal(cleanLabel('x'.repeat(MAX_TAB_LABEL)), 'x'.repeat(MAX_TAB_LABEL));
ok('labels are capped at 40 characters');

// 4. Titles that say nothing about the work are ignored.
for (const t of ['zsh', '-zsh', 'bash', '/bin/zsh', 'fish', 'login',
  '~', '~/Projects (Code)/dobius-plus', '/Users/sam/Projects',
  'sam@mac: ~/Projects', 'sam@macbook', 'Claude Code', '✳ Claude Code', 'claude', 'codex',
  'claude --resume 7c0e5d1a-1111-2222-3333-444455556666', '', '   ', '✳', null, undefined]) {
  assert.equal(labelFromTitle(t), null, `should ignore ${JSON.stringify(t)}`);
}
assert.equal(labelFromTitle('npm run dev'), 'npm run dev');
assert.equal(labelFromTitle('Claude settings review'), 'Claude settings review');
ok('shell names, paths, prompts and bare Claude/Codex titles are ignored');

// 5. Title source: applies to an unlocked tab, and an unchanged title is the
// SAME object (no store update, no config write on every spinner frame).
const base = { id: 't1', label: 'Tab 1' };
const t1 = applyAutoLabel(base, '✳ Fix login bug', 'title');
assert.equal(t1.label, 'Fix login bug');
assert.equal(t1.labelSource, 'title');
assert.equal(applyAutoLabel(t1, '⠂ Fix login bug', 'title'), t1);
assert.equal(applyAutoLabel(t1, 'zsh', 'title'), t1);
assert.equal(applyAutoLabel(base, 'x', 'bogus'), base);
ok('a title labels an unlocked tab; repeats are no-ops');

// 6. Manual lock wins over both automatic sources, but the latest automatic
// label is remembered for when the user unlocks.
const locked = lockLabel(t1, 'My name');
assert.equal(locked.labelLockedByUser, true);
const afterTitle = applyAutoLabel(locked, '✳ Write tests', 'title');
assert.equal(afterTitle.label, 'My name');
assert.equal(afterTitle.autoLabel, 'Write tests');
const afterAgent = applyAutoLabel(afterTitle, 'Ship the release', 'agent');
assert.equal(afterAgent.label, 'My name');
assert.equal(afterAgent.autoLabel, 'Ship the release');
// A later title does not displace the remembered agent label either.
assert.equal(applyAutoLabel(afterAgent, '✳ Something else', 'title'), afterAgent);
ok('a manual rename locks out title and agent labels');

// 7. Clearing the name unlocks and shows the latest automatic label.
const unlocked = unlockLabel(afterAgent);
assert.equal(unlocked.labelLockedByUser, false);
assert.equal(unlocked.label, 'Ship the release');
assert.equal(unlocked.labelSource, 'agent');
const unlockedPlain = unlockLabel(lockLabel(base, 'Mine'));
assert.equal(unlockedPlain.label, 'Mine');
assert.equal(unlockedPlain.labelSource, undefined);
// Once unlocked, automatic labels flow again.
assert.equal(applyAutoLabel(unlockedPlain, '✳ Deploy', 'title').label, 'Deploy');
ok('unlocking hands the tab back to automatic labels');

// 8. Agent beats title: Claude's own title updates never undo the summary
// the agent chose with dobius-tab, but a new agent label replaces it.
const byAgent = applyAutoLabel(t1, 'Audit billing webhooks', 'agent');
assert.equal(byAgent.label, 'Audit billing webhooks');
assert.equal(applyAutoLabel(byAgent, '✳ Some topic', 'title'), byAgent);
assert.equal(applyAutoLabel(byAgent, 'Fix webhook retry', 'agent').label, 'Fix webhook retry');
// Agent labels are cleaned (glyphs, cap) but NOT filtered: the agent chose them.
assert.equal(applyAutoLabel(base, '  ✳ zsh  ', 'agent').label, 'zsh');
assert.equal(applyAutoLabel(base, '   ', 'agent'), base);
ok('an agent label outranks the terminal title');

// 9. Tabs persisted before this feature carry no flags. A hand-set or
// agent-launch name on one must stay; a default `Tab N` must not block titles.
const legacyNamed = { id: 't9', label: 'Billing' };
const legacyAgent = { id: 't10', label: '[O] Write migration' };
assert.equal(applyAutoLabel(legacyNamed, '✳ Fix login bug', 'title').label, 'Billing');
assert.equal(applyAutoLabel(legacyAgent, 'Something', 'agent').label, '[O] Write migration');
assert.equal(applyAutoLabel({ id: 't11', label: 'Tab 7' }, '✳ Fix login bug', 'title').label, 'Fix login bug');
assert.equal(applyAutoLabel({ id: 't12', label: 'Tab' }, '✳ Fix login bug', 'title').label, 'Fix login bug');
assert.equal(applyAutoLabel(unlockLabel(legacyNamed), '✳ Fix login bug', 'title').label, 'Fix login bug');
assert.equal(isLabelLocked(t1), false);
ok('legacy tabs with a custom name are treated as locked');

// 10. Tear-off round trip keeps the label state: an agent label still
// outranks titles in the new window, a lock stays a lock.
const tornAgent = { id: 't13', label: 'Audit billing webhooks', ...parseLabelMeta(JSON.stringify(labelMeta(byAgent))) };
assert.equal(applyAutoLabel(tornAgent, '✳ Fix login bug', 'title'), tornAgent);
const tornLocked = { id: 't14', label: 'My name', ...parseLabelMeta(JSON.stringify(labelMeta(afterAgent))) };
assert.equal(isLabelLocked(tornLocked), true);
assert.equal(unlockLabel(tornLocked).label, 'Ship the release');
assert.deepEqual(parseLabelMeta('not json'), {});
assert.deepEqual(parseLabelMeta('{"labelSource":"evil","labelLockedByUser":"yes"}'), {});
ok('label state survives a tear-off');

// 11. History names a session after its tab, but only a REAL name: the
// app's own defaults fall through to Claude's summary.
assert.equal(sessionNameFromTabLabel('Email'), 'Email');
assert.equal(sessionNameFromTabLabel('  refund\n commish \u0007'), 'refund commish');
assert.equal(sessionNameFromTabLabel('* urgent'), '* urgent');
for (const d of ['Tab', 'Tab 3', 'Tab 104', 'Browser', '', '   ', null, undefined, 42]) {
  assert.equal(sessionNameFromTabLabel(d), null, String(d));
}
assert.equal(sessionNameFromTabLabel('Tab 3 billing'), 'Tab 3 billing');
assert.equal(Array.from(sessionNameFromTabLabel('😀'.repeat(80))).length, MAX_SESSION_NAME);
ok('a tab name becomes a session name, default names do not');

console.log(`\n${pass} passed`);

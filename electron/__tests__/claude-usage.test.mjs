// Per-account usage, as last REPORTED by a live session (v1.0.76).
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/claude-usage.test.mjs
//
// The design review's verdict was that the transport is fine and the
// AGGREGATION is where this goes wrong, so most of this file is about what may
// beat what. The payload carries no measurement timestamp, so nothing here can
// prove a number is current; it can only refuse to present an old one as new.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  parseRecord, aggregateUsage, reporterScript,
  planStatusLineInstall, planStatusLineRemove, ownsStatusLine, REPORTER_MARKER,
  reporterCommand,
} from '../claude-usage.js';

// Ownership is detected by the marker appearing in the command string, and the
// only thing that puts it there is the script's own filename. Pin that, or a
// rename would silently make every installed reporter unrecognisable and
// uninstall would stop restoring anyone's status line.
const SCRIPT = reporterCommand('/u');

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

const rec = ({ sid = 's1', set = 1, dir = '/Users/x/.claude-profiles/a', limits, extra = {} }) => {
  const payload = JSON.stringify({ session_id: sid, ...(limits ? { rate_limits: limits } : {}), ...extra });
  return `DOBIUS1 ${set}\n${dir}\n${payload}`;
};
const FIVE = { five_hour: { used_percentage: 38, resets_at: 4000000000 } };

check('a record carries the binding, the windows and the session', () => {
  const r = parseRecord(rec({ limits: FIVE }), 1000);
  assert.equal(r.sessionId, 's1');
  assert.equal(r.configDir, '/Users/x/.claude-profiles/a');
  assert.equal(r.envUnset, false);
  assert.equal(r.windows.five_hour.usedPercentage, 38);
  assert.equal(r.receivedAt, 1000);
});

check('UNSET is not the same binding as empty, and maps to the CLI default', () => {
  // Unset reads the home-level metadata file and the bare Keychain service.
  // Collapsing it into "some directory" is what made the default account
  // unreadable in the switch work.
  const r = parseRecord(`DOBIUS1 0\n\n${JSON.stringify({ session_id: 's', rate_limits: FIVE })}`, 1);
  assert.equal(r.envUnset, true);
  assert.equal(r.configDir, path.join(os.homedir(), '.claude'));
  assert.ok(r.key, 'the default credential still resolves to a key');
});

check('a RELATIVE binding names no credential', () => {
  // The CLI resolves it against its own cwd, which the reporter cannot know.
  const r = parseRecord(rec({ dir: '.claude', limits: FIVE }), 1);
  assert.equal(r.key, null);
  assert.equal(r.unresolvedBinding, true);
});

check('missing rate_limits is UNKNOWN, never zero', () => {
  // The key is absent until the session's first API call, which is why every
  // "it is broken upstream" report exists. Absent must not render as 0% used.
  const r = parseRecord(rec({}), 1);
  assert.equal(r.windows, null);
});

check('a window with a junk percentage is dropped, not coerced', () => {
  const r = parseRecord(rec({ limits: { five_hour: { used_percentage: 'lots' }, seven_day: { used_percentage: 12 } } }), 1);
  assert.equal(r.windows.five_hour, undefined);
  assert.equal(r.windows.seven_day.usedPercentage, 12);
});

check('unknown window names survive, because the set is not fixed', () => {
  // The binary also names seven_day_opus / _sonnet / _cowork. Hard-coding two
  // fields would silently discard a limit the user is actually hitting.
  const r = parseRecord(rec({ limits: { seven_day_opus: { used_percentage: 91, resets_at: 4000000000 } } }), 1);
  assert.equal(r.windows.seven_day_opus.usedPercentage, 91);
});

check('a truncated or foreign record is refused', () => {
  assert.equal(parseRecord('DOBIUS1 1\n/dir', 1), null);
  assert.equal(parseRecord('OTHER 1\n/dir\n{}', 1), null);
  assert.equal(parseRecord(`DOBIUS1 1\n/dir\n{not json`, 1), null);
  assert.equal(parseRecord(`DOBIUS1 1\n/dir\nnull`, 1), null);
});

check('the newest RECEIPT wins for one credential', () => {
  const a = parseRecord(rec({ sid: 'old', limits: { five_hour: { used_percentage: 10, resets_at: 4e9 } } }), 1000);
  const b = parseRecord(rec({ sid: 'new', limits: { five_hour: { used_percentage: 62, resets_at: 4e9 } } }), 2000);
  const [g] = aggregateUsage([a, b], { now: 3000 });
  assert.equal(g.windows.five_hour.usedPercentage, 62);
});

check('the reporter COMMAND is shell-quoted', () => {
  // statusLine is a shell command, and userData on macOS lives under
  // "Library/Application Support". Unquoted, the shell splits it at the space
  // and every render dies before the reporter starts, taking the user's own
  // status line with it.
  const cmd = reporterCommand('/Users/x/Library/Application Support/dobius-plus');
  assert.ok(cmd.startsWith("'") && cmd.endsWith("'"), 'quoted end to end');
  assert.ok(ownsStatusLine({ type: 'command', command: cmd }), 'still recognised as ours');
});

check('age travels with the reading', () => {
  const r = parseRecord(rec({ limits: FIVE }), 1000);
  const [g] = aggregateUsage([r], { now: 61000 });
  assert.equal(g.ageMs, 60000);
});

check('a window past its own reset is DROPPED, not shown as zero', () => {
  // Showing 0% for the new window would invent a measurement nobody made.
  const r = parseRecord(rec({ limits: { five_hour: { used_percentage: 99, resets_at: 1000 } } }), 500);
  assert.deepEqual(aggregateUsage([r], { now: 2_000_000 }), []);
});

check('windows expire INDEPENDENTLY', () => {
  const r = parseRecord(rec({
    limits: {
      five_hour: { used_percentage: 99, resets_at: 1000 },
      seven_day: { used_percentage: 40, resets_at: 4e9 },
    },
  }), 500);
  const [g] = aggregateUsage([r], { now: 2_000_000 });
  assert.equal(g.windows.five_hour, undefined);
  assert.equal(g.windows.seven_day.usedPercentage, 40);
});

check('an unresolved binding contributes nothing', () => {
  const r = parseRecord(rec({ dir: 'relative', limits: FIVE }), 1);
  assert.deepEqual(aggregateUsage([r], { now: 2 }), []);
});

// --- the reporter script itself -------------------------------------------
check('the script never spawns a helper process', () => {
  // It runs on every render across every session. jq, date or a hash utility
  // would multiply process startup by the render rate.
  const s = reporterScript('/u/usage', null);
  for (const bad of ['jq', '$(date', 'shasum', 'openssl', 'python']) {
    assert.ok(!s.includes(bad), `script must not use ${bad}`);
  }
  assert.ok(s.includes('mv -f'), 'publishes by rename');
  assert.ok(s.includes('.tmp.$sid.$$'), 'unique temp name per invocation');
});

check('the script refuses a session id that is not a plain id', () => {
  // The payload is DATA. A crafted session_id must not steer the write.
  assert.ok(reporterScript('/u/usage', null).includes('*[!A-Za-z0-9_-]*'));
});

check('a chained command gets its stdin REPLAYED', () => {
  // The reporter has already consumed stdin. Handing the user's command an EOF
  // makes it print nothing and their status line silently disappears.
  const s = reporterScript('/u/usage', 'my-line.sh --flag');
  assert.ok(s.includes('printf \'%s\' "$payload" |'), 'replays the payload');
  assert.ok(s.includes("'my-line.sh --flag'"), 'runs the original command verbatim');
});

check("a chained command's quotes cannot break out of the script", () => {
  const s = reporterScript('/u/usage', "evil'; rm -rf /; echo '");
  assert.ok(!s.includes('rm -rf /;\n'), 'no unescaped injection');
  assert.ok(s.includes(`'\\''`), 'single quotes are escaped');
});

// --- install and uninstall ------------------------------------------------
check('the reporter path carries the marker that proves ownership', () => {
  assert.ok(SCRIPT.includes(REPORTER_MARKER));
  assert.ok(ownsStatusLine({ type: 'command', command: SCRIPT }));
  assert.equal(ownsStatusLine({ type: 'command', command: '/u/someone-else.sh' }), false);
  assert.equal(ownsStatusLine(undefined), false);
  assert.equal(ownsStatusLine({ type: 'command' }), false);
});

check('installing over NOTHING remembers that there was nothing', () => {
  const { statusLine, remember } = planStatusLineInstall(undefined, SCRIPT);
  assert.ok(ownsStatusLine(statusLine));
  assert.equal(remember.present, false);
});

check("installing over a user's line chains it and keeps their options", () => {
  const cur = { type: 'command', command: 'mine.sh', padding: 0 };
  const { statusLine, remember } = planStatusLineInstall(cur, SCRIPT);
  assert.equal(statusLine.padding, 0, 'options are carried across');
  assert.equal(statusLine.command, SCRIPT);
  assert.equal(remember.chain, 'mine.sh');
});

check('installing TWICE does not wrap our own wrapper', () => {
  // Otherwise the script execs itself and the status line recurses.
  const first = planStatusLineInstall({ type: 'command', command: 'mine.sh' }, SCRIPT);
  const second = planStatusLineInstall(first.statusLine, SCRIPT);
  assert.equal(second.remember, null, 'keeps the stored original rather than saving ourselves');
  assert.ok(!second.statusLine.command.includes(REPORTER_MARKER + REPORTER_MARKER));
});

check('uninstalling restores the exact original', () => {
  const cur = { type: 'command', command: 'mine.sh', padding: 0 };
  const { statusLine, remember } = planStatusLineInstall(cur, SCRIPT);
  const out = planStatusLineRemove(statusLine, remember);
  assert.equal(out.action, 'restore');
  assert.equal(out.statusLine.command, 'mine.sh');
});

check('uninstalling when there was nothing REMOVES the key', () => {
  const { statusLine, remember } = planStatusLineInstall(undefined, SCRIPT);
  assert.equal(planStatusLineRemove(statusLine, remember).action, 'delete');
});

check('uninstalling NEVER overwrites a line the user has since chosen', () => {
  // Blind restoration would delete a deliberate newer choice.
  const { remember } = planStatusLineInstall({ type: 'command', command: 'old.sh' }, SCRIPT);
  assert.equal(planStatusLineRemove({ type: 'command', command: 'brand-new.sh' }, remember).action, 'leave');
});

console.log(`\nALL PASS  (${pass} passed)`);

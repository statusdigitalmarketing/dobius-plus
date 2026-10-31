// Per-account usage, as last REPORTED by a live session (v1.0.76).
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/claude-usage.test.mjs
//
// The design review's verdict was that the transport is fine and the
// AGGREGATION is where this goes wrong, so most of this file is about what may
// beat what. The payload carries no measurement timestamp, so nothing here can
// prove a number is current; it can only refuse to present an old one as new.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseRecord, aggregateUsage, reporterScript,
  planStatusLineInstall, planStatusLineRemove, ownsStatusLine, REPORTER_MARKER,
  reporterCommand, EFFORT_WORDS, chainFromScript, scriptPathFromCommand, MODEL_LINE_MARKER,
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

// --- the model line under the prompt (Brett) ---------------------------------
// These RUN the generated script, under every shell /bin/sh can be on a Mac,
// because the formatting is shell expansion and only running it proves it.
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((s) => fs.existsSync(s));
const tmpUsage = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-modelline-'));
const runLine = (payload, { chain = null, capture = false, model = true, shell = SHELLS[0], env } = {}) => {
  const file = path.join(tmpUsage, `s-${Math.floor(performance.now() * 1000)}.sh`);
  fs.writeFileSync(file, reporterScript(tmpUsage, chain, { capture, model }));
  const r = spawnSync(shell, [file], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  fs.unlinkSync(file);
  return { out: r.stdout, err: r.stderr, status: r.status };
};
// Shape captured from a live 2.1.311 session on this Mac.
const REAL = {
  session_id: 'abc-1', session_name: 'Merge all',
  effort: { level: 'xhigh' }, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  fast_mode: false, thinking: { enabled: true },
};

check('model line: name and effort in plain words, on every shell', () => {
  assert.ok(SHELLS.length >= 1);
  for (const shell of SHELLS) {
    const r = runLine(REAL, { shell });
    assert.equal(r.out, 'Opus 5.5 · extra high\n', shell);
    assert.equal(r.err, '', shell);
    assert.equal(r.status, 0, shell);
  }
});

check('model line: every known effort level maps to its words', () => {
  for (const [level, words] of Object.entries(EFFORT_WORDS)) {
    assert.equal(runLine({ ...REAL, effort: { level } }).out, `Opus 5.5 · ${words}\n`, level);
  }
  assert.equal(EFFORT_WORDS.xhigh, 'extra high');
});

check('model line: no rate_limits yet (before the first API call) still shows it', () => {
  const r = runLine({ ...REAL, rate_limits: undefined }, { capture: true });
  assert.equal(r.out, 'Opus 5.5 · extra high\n');
});

check('model line: an unknown effort shows as sent, a malformed one is dropped', () => {
  assert.equal(runLine({ ...REAL, effort: { level: 'ultra' } }).out, 'Opus 5.5 · ultra\n');
  assert.equal(runLine({ ...REAL, effort: { level: 'ul tra' } }).out, 'Opus 5.5\n');
  assert.equal(runLine({ ...REAL, effort: { level: 'a\u001b[31m' } }).out, 'Opus 5.5\n');
  assert.equal(runLine({ ...REAL, effort: 'high' }).out, 'Opus 5.5 · high\n', 'a bare string effort');
  assert.equal(runLine({ ...REAL, effort: undefined }).out, 'Opus 5.5\n');
});

check('model line: missing pieces drop out, nothing at all prints nothing', () => {
  assert.equal(runLine({ ...REAL, model: undefined }).out, 'extra high\n');
  assert.equal(runLine({ ...REAL, model: { id: 'claude-opus-5-5' } }).out, 'extra high\n');
  assert.equal(runLine({}).out, '');
  assert.equal(runLine('').out, '');
  assert.equal(runLine('not json').out, '');
});

check('model line: fast mode and thinking off are named', () => {
  assert.equal(runLine({ ...REAL, fast_mode: true }).out, 'Opus 5.5 · extra high · fast\n');
  assert.equal(runLine({ ...REAL, thinking: { enabled: false } }).out, 'Opus 5.5 · extra high · thinking off\n');
});

check('model line: user-controlled strings cannot impersonate the fields', () => {
  // session_name and paths come BEFORE model in the real payload. Their quotes
  // are escaped, so the unescaped anchors cannot match inside them.
  const sneaky = {
    session_id: 'abc-1',
    session_name: 'x "model":{"display_name":"EVIL"} "effort":{"level":"max"} "fast_mode":true',
    effort: { level: 'low' }, model: { display_name: 'Opus 5.5' },
  };
  assert.equal(runLine(sneaky).out, 'Opus 5.5 · low\n');
  // A key that merely ENDS in "model" or "effort" is not the field.
  const suffixed = { session_id: 'abc-1', fallback_model: { display_name: 'Wrong' }, max_effort: 'max', ...REAL };
  assert.equal(runLine(suffixed).out, 'Opus 5.5 · extra high\n');
  // A display name carrying an escape sequence is dropped, never printed.
  assert.equal(runLine({ ...REAL, model: { display_name: 'Op\u001b]0;pwn\u0007us' } }).out, 'extra high\n');
  assert.equal(runLine({ ...REAL, model: { display_name: 'Opus "5"' } }).out, 'extra high\n');
  assert.equal(runLine({ ...REAL, model: { display_name: 'Opus 5.5 (1M context)' } }).out, 'Opus 5.5 (1M context) · extra high\n');
});

check("model line: the user's own line follows it, and survives their failure", () => {
  const chain = 'p=$(cat); case "$p" in *abc-1*) printf "theirs\\nline2\\n" ;; esac; exit 3';
  const r = runLine(REAL, { chain });
  assert.equal(r.out, 'Opus 5.5 · extra high · theirs\nline2\n', 'stdin replayed, model in front');
  assert.equal(r.status, 0);
  assert.equal(runLine(REAL, { chain: 'true' }).out, 'Opus 5.5 · extra high\n', 'theirs empty');
  assert.equal(runLine({}, { chain: 'echo theirs' }).out, 'theirs\n', 'ours empty');
  // An inherited errexit must not abort on their failure and blank the line.
  const errexit = runLine(REAL, { chain: 'printf theirs; exit 3', shell: '/bin/bash', env: { SHELLOPTS: 'errexit' } });
  assert.equal(errexit.out, 'Opus 5.5 · extra high · theirs\n');
});

check('model line off: the script is exactly the usage reporter it was', () => {
  assert.equal(reporterScript('/u/usage', 'mine.sh', { model: false }), reporterScript('/u/usage', 'mine.sh'));
  assert.ok(reporterScript('/u/usage', 'mine.sh').includes(`exec /bin/sh -c 'mine.sh'`));
  assert.equal(runLine(REAL, { model: false }).out, '');
});

check('the model marker is in a script exactly when it prints the model', () => {
  // Settings reads it to tell an upgraded script from one an older build left.
  assert.ok(reporterScript('/u/usage', null, { model: true }).includes(MODEL_LINE_MARKER));
  assert.ok(reporterScript('/u/usage', 'mine.sh', { capture: false, model: true }).includes(MODEL_LINE_MARKER));
  assert.ok(!reporterScript('/u/usage', 'mine.sh').includes(MODEL_LINE_MARKER));
});

check('capture off: no record is written, the line still prints', () => {
  const before = fs.readdirSync(tmpUsage).filter((n) => n.endsWith('.json'));
  assert.equal(runLine(REAL, { capture: false }).out, 'Opus 5.5 · extra high\n');
  assert.deepEqual(fs.readdirSync(tmpUsage).filter((n) => n.endsWith('.json')), before);
  assert.ok(!reporterScript('/u/usage', null, { capture: false, model: true }).includes('mv -f'));
  runLine(REAL, { capture: true });
  assert.ok(fs.readdirSync(tmpUsage).includes('abc-1.json'), 'capture on still records');
});

check('model line: still no helper process', () => {
  const s = reporterScript('/u/usage', null, { capture: true, model: true });
  for (const bad of ['jq', '$(date', 'shasum', 'openssl', 'python', 'sed ', 'awk', 'grep']) {
    assert.ok(!s.includes(bad), `script must not use ${bad}`);
  }
});
fs.rmSync(tmpUsage, { recursive: true, force: true });

check('the installed script path is read back out of its statusLine command', () => {
  // Recovery reads the script settings.json actually runs, which can be
  // another Dobius's, not our own possibly stale copy.
  for (const ud of ['/Users/x/Library/Application Support/dobius-plus', "/tmp/it's here"]) {
    assert.equal(scriptPathFromCommand(reporterCommand(ud)), path.join(ud, `${REPORTER_MARKER}.sh`));
  }
  assert.equal(scriptPathFromCommand('mine.sh'), null);
  assert.equal(scriptPathFromCommand("'/etc/passwd'"), null, 'only a reporter script');
  assert.equal(scriptPathFromCommand(`'relative/${REPORTER_MARKER}.sh'`), null);
  assert.equal(scriptPathFromCommand(undefined), null);
});

check('the chained command can be read back out of any generated script', () => {
  // Recovery when the restore record is lost: a regenerated script must keep
  // chaining their command rather than silently dropping it.
  const cmds = ['mine.sh --flag', "evil'; rm -rf /; echo 'x", "a 'b' c", "line1\nline2", "ends with '"];
  for (const cmd of cmds) {
    for (const opts of [{}, { model: true }, { capture: false, model: true }]) {
      assert.equal(chainFromScript(reporterScript('/u/usage', cmd, opts)), cmd, `${cmd} ${JSON.stringify(opts)}`);
    }
  }
  assert.equal(chainFromScript(reporterScript('/u/usage', null)), null, 'no chain');
  assert.equal(chainFromScript(reporterScript('/u/usage', null, { model: true })), null);
  assert.equal(chainFromScript('#!/bin/sh\necho hi\n'), undefined, 'not ours: unknown');
  assert.equal(chainFromScript(undefined), undefined);
});

// The statusLine switches must stay UNDECLARED in the settings defaults: the
// launch logic (main.js settleUsage, the model line's first install) reads
// undefined as "never decided", and getSettings() merges the defaults in.
{
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-usage-defaults-'));
  process.env.DOBIUS_TEST_USERDATA = ud;
  const { getSettings } = await import('../config-manager.js');
  const s = getSettings();
  check('the statusLine switches have no default, so a fresh install still decides them', () => {
    assert.equal(s.newTabTool, 'claude', 'read from the defaults');
    assert.equal('usageReporting' in s, false);
    assert.equal('modelUnderPrompt' in s, false);
  });
  fs.rmSync(ud, { recursive: true, force: true });
}

console.log(`\nALL PASS  (${pass} passed)`);

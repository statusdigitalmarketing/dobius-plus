// The "run this yourself" rule (shared/handoff.js): the JS form and the grep
// form the Claude Stop hook runs must agree on every case.
import { isHandoff, isHandoffStop, HANDOFF_SHELL, stopHookCommand } from '../../shared/handoff.js';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
// What Claude's Stop hook receives on stdin, with this message.
const payload = (msg) => JSON.stringify({ session_id: 's', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg, background_tasks: [] });
// Exactly what the installed Stop hook runs, through a real shell.
const grepSays = (msg) => spawnSync('/bin/sh', ['-c', HANDOFF_SHELL], { input: payload(msg) }).status === 0;

const cases = [
  ['the measured handoff', 'Run this yourself:\n! echo dobius-bang-test', true],
  ['the screenshot handoff (blank line, then the command)', 'Those two are still waiting on you:\n\n! cd "/Users/x/axiom-connect" && gh pr merge 1968 --squash\n\nNothing else is running.', true],
  ['the command as the whole reply', '! npm run deploy', true],
  ['indented', 'Run:\n   ! gws auth login', true],
  ['inside one backtick', 'Run:\n`! gws auth login`', true],
  ['in a fenced block', 'Run:\n```\n! git push\n```', true],
  ['a plain finished reply', 'Done. The tests pass and the PR is merged.', false],
  ['a ! mentioned mid-sentence', 'suggest they type `! <command>` in the prompt', false],
  ['an exclamation at a line start', 'Shipped.\n!!! that was fast', false],
  ['a bare ! line', 'Wow\n!\nok', false],
  ['! with no space (not the convention)', 'Run:\n!ls', false],
  ['no message at all', null, false],
  ['a bulleted command', 'Run this yourself:\n- `! npm run deploy`', true],
  ['a numbered command', 'Two steps:\n1. ! gws auth login\n2. tell me when done', true],
  ['a literal backslash-n is not a line break', 'The literal text is \\n! echo demo.', false],
  ['an exclamation and a space only', '! ', false],
  ['quotes and escapes in the command', 'Run:\n! cd "/Users/x/Projects (Code)/a" && echo \\"hi\\"', true],
  ['a 300KB reply ending in a handoff', 'a'.repeat(300000) + '\n! git push', true],
];
for (const [label, msg, want] of cases) {
  check(`js:   ${label}`, isHandoff(msg), want);
  check(`grep: ${label}`, grepSays(msg), want);
}

// Background work still running: not yet (measured payload shape, 2.1.316).
const shellSays = (input) => spawnSync('/bin/sh', ['-c', HANDOFF_SHELL], { input: JSON.stringify(input) }).status === 0;
const running = { id: 'bhm3ebyw0', type: 'shell', status: 'running', description: 'Sleep 20 seconds in the background', command: 'sleep 20' };
const bgCases = [
  ['a handoff while a background task runs', { last_assistant_message: 'The background sleep is running.\n\nRun this yourself:\n! echo after-bg', background_tasks: [running] }, false],
  ['the same handoff once it has finished', { last_assistant_message: 'It finished.\n\nRun this yourself:\n! echo after-bg', background_tasks: [] }, true],
  ['a finished task still listed', { last_assistant_message: 'Run:\n! git push', background_tasks: [{ ...running, status: 'completed' }] }, true],
  ['no background_tasks field (older Claude)', { last_assistant_message: 'Run:\n! git push' }, true],
  ['a reply that QUOTES "status":"running" is still a handoff', { last_assistant_message: 'The API said {"status":"running"}.\nRun:\n! git push', background_tasks: [] }, true],
];
for (const [label, input, want] of bgCases) {
  check(`js:    ${label}`, isHandoffStop(input), want);
  check(`shell: ${label}`, shellSays(input), want);
}

// The whole Stop command, run as the hook runs it: which marker it prints.
// A turn that ends with background work running stays working (Sam: the
// phone said "done" while a Codex review was still going).
{
  const stop = stopHookCommand((state) => `printf '%s' '${state}'`);
  const says = (input) => spawnSync('/bin/sh', ['-c', stop], { input: JSON.stringify(input) }).stdout.toString();
  const bg = [{ id: 'b1', status: 'running' }];
  check('stop: plain turn is done', says({ last_assistant_message: 'All set.', background_tasks: [] }), 'done');
  check('stop: handoff is red', says({ last_assistant_message: 'Run this:\n! npm run deploy', background_tasks: [] }), 'needs;handoff');
  check('stop: background running stays working', says({ last_assistant_message: 'Codex is reviewing.', background_tasks: bg }), 'working;background');
  check('stop: pending counts too', says({ last_assistant_message: 'x', background_tasks: [{ status: 'pending' }] }), 'working;background');
  check('stop: handoff with background running waits', says({ last_assistant_message: '! npm run deploy', background_tasks: bg }), 'working;background');
  check('stop: finished background is done', says({ last_assistant_message: 'Done.', background_tasks: [{ status: 'completed' }] }), 'done');
  check('stop: no field is done', says({ last_assistant_message: 'Done.' }), 'done');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

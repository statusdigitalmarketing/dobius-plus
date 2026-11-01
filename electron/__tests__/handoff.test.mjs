// The "run this yourself" rule (shared/handoff.js): the JS form and the grep
// form the Claude Stop hook runs must agree on every case.
import { isHandoff, HANDOFF_SHELL } from '../../shared/handoff.js';
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

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

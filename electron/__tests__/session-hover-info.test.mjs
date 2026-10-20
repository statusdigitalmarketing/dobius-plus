// getSessionHoverInfo feeds the History hover card. HOME points at a throwaway
// dir before importing, same trick as automated-sessions.test.mjs.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-hover-home-'));
process.env.HOME = TMP_HOME;
const { getSessionHoverInfo } = await import('../data-service.js');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

const PROJECT = '/tmp/fakeproj';
const dir = path.join(TMP_HOME, '.claude', 'projects', '-tmp-fakeproj');
await fs.mkdir(dir, { recursive: true });
const user = (content, extra = {}) => JSON.stringify({ type: 'user', cwd: PROJECT, gitBranch: 'feat/x', message: { role: 'user', content }, ...extra });
const assistant = (text, extra = {}) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 99990 } },
  ...extra,
});
const write = (id, lines) => fs.writeFile(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');

await write('done', [
  user('first question'),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the login bug' }),
  assistant('looked at it'),
  user('now  fix\n the   login bug'),
  assistant('## Done\n**Fixed** it in `auth.js`'),
  // Trailing synthetic user text must not become "You".
  user('<task-notification>agent finished</task-notification>'),
]);
const info = await getSessionHoverInfo('done', PROJECT);
check('title from ai-title record', info?.title, 'Fix the login bug');
check('last prompt skips synthetic text and collapses whitespace', info?.lastPrompt, 'now fix the login bug');
check('last reply drops markdown markers', info?.lastReply, 'Done Fixed it in auth.js');
check('ending', info?.ending, 'delivered');
check('branch + cwd', [info?.branch, info?.cwd], ['feat/x', PROJECT]);
check('model + tokens', [info?.model, info?.tokens], ['claude-opus-4-8', 100000]);

await write('waiting', [user('hello', { gitBranch: 'HEAD' })]);
const w = await getSessionHoverInfo('waiting', PROJECT);
check('unanswered ending, HEAD is not a branch, no title', [w?.ending, w?.branch, w?.title, w?.lastReply], ['unanswered', '', '', '']);

// Cache: unchanged file returns the same object; a write is picked up.
const again = await getSessionHoverInfo('done', PROJECT);
check('unchanged file served from cache', again === info, true);
await fs.appendFile(path.join(dir, 'done.jsonl'), user('one more thing') + '\n');
const after = await getSessionHoverInfo('done', PROJECT);
check('changed file re-read', after?.lastPrompt, 'one more thing');

// Same size + same mtime, different file (a restore): inode/ctime catch it.
const donePath = path.join(dir, 'done.jsonl');
const st0 = await fs.stat(donePath);
const body = (await fs.readFile(donePath, 'utf8')).replace('one more thing', 'two more thing');
await fs.writeFile(`${donePath}.new`, body);
await fs.utimes(`${donePath}.new`, st0.atime, st0.mtime);
await fs.rename(`${donePath}.new`, donePath);
check('same-size same-mtime replacement re-read', (await getSessionHoverInfo('done', PROJECT))?.lastPrompt, 'two more thing');

// Traversal: '..' and '/..' must never leave ~/.claude/projects. Plant a
// transcript-shaped file one level up and make sure it is unreachable.
await fs.writeFile(path.join(TMP_HOME, '.claude', 'private.jsonl'), user('secret') + '\n');
check("projectPath '..' cannot read ~/.claude", await getSessionHoverInfo('private', '..'), null);
check("projectPath '/..' cannot read ~/.claude", await getSessionHoverInfo('private', '/..'), null);
check("projectPath '.' cannot read projects root", await getSessionHoverInfo('private', '.'), null);

// Symlinks: a linked transcript or project dir must not be followed out.
await fs.symlink(path.join(TMP_HOME, '.claude', 'private.jsonl'), path.join(dir, 'linked.jsonl'));
check('symlinked transcript pointing outside is refused', await getSessionHoverInfo('linked', PROJECT), null);
await fs.symlink(path.join(TMP_HOME, '.claude'), path.join(TMP_HOME, '.claude', 'projects', '-tmp-escape'));
check('symlinked project dir pointing outside is refused', await getSessionHoverInfo('private', '/tmp/escape'), null);

// A read error is not cached as an empty card.
await write('locked', [user('can you see me'), assistant('yes')]);
await fs.chmod(path.join(dir, 'locked.jsonl'), 0o000);
check('unreadable transcript answers null', await getSessionHoverInfo('locked', PROJECT), null);
await fs.chmod(path.join(dir, 'locked.jsonl'), 0o644);
check('readable again is not stuck on the failure', (await getSessionHoverInfo('locked', PROJECT))?.lastPrompt, 'can you see me');

// A reply that quotes the interrupt marker is a reply, not an interrupt.
await write('quoted', [user('what does that mean'), assistant('old'), user('and?'), assistant('[x] The text [Request interrupted by user] means you pressed Esc.')]);
const q = await getSessionHoverInfo('quoted', PROJECT);
check('quoted marker in a reply: still delivered', [q?.ending, q?.lastReply.startsWith('[x] The text')], ['delivered', true]);
await write('quoted-start', [user('q'), assistant('[Request interrupted by user] means you pressed Esc.')]);
check('a reply that STARTS with the marker is still a reply',
  (await getSessionHoverInfo('quoted-start', PROJECT))?.ending, 'delivered');
await write('tool-interrupt', [user('go'), assistant('on it'), user('[Request interrupted by user for tool use]')]);
check('the tool-use marker variant is an interrupt', (await getSessionHoverInfo('tool-interrupt', PROJECT))?.ending, 'interrupted');

// String token counts must not concatenate into a giant cached string.
await write('strtokens', [user('hi'), JSON.stringify({
  type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: '9'.repeat(1000), cache_read_input_tokens: 5 } },
})]);
const stk = await getSessionHoverInfo('strtokens', PROJECT);
check('string token counts are ignored, numbers kept', [typeof stk?.tokens, stk?.tokens], ['number', 5]);

// A FIFO named like a transcript must be refused before anything opens it.
execFileSync('mkfifo', [path.join(dir, 'fifo.jsonl')]);
check('a FIFO transcript is refused (no hang)', await getSessionHoverInfo('fifo', PROJECT), null);

await write('interrupted', [user('do it'), assistant('working'), user('[Request interrupted by user]')]);
check('the real marker row is still an interrupt', (await getSessionHoverInfo('interrupted', PROJECT))?.ending, 'interrupted');

await write('odd', [
  user('Why did you print [Request interrupted by user]?'),
  'null', '42',
  assistant('Edited `__init__.py`'),
]);
const odd = await getSessionHoverInfo('odd', PROJECT);
check('null/number lines are skipped, not fatal', odd?.model, 'claude-opus-4-8');
check('a prompt quoting the interrupt marker still counts', odd?.lastPrompt, 'Why did you print [Request interrupted by user]?');
check('code identifiers keep their underscores', odd?.lastReply, 'Edited __init__.py');

// A finished turn buried under 250 metadata records: the wider read supplies
// the reply, ending and context as well as the prompt.
await write('buried', [user('ship it'), assistant('Shipped.'), ...Array.from({ length: 250 }, () => JSON.stringify({ type: 'system' }))]);
const bur = await getSessionHoverInfo('buried', PROJECT);
check('buried turn: prompt, reply, ending, tokens from the wider read',
  [bur?.lastPrompt, bur?.lastReply, bur?.ending, bur?.tokens], ['ship it', 'Shipped.', 'delivered', 100000]);

// A new prompt lands within 200 records but the reply/usage are still beyond:
// the wider read must still supply them.
await fs.appendFile(path.join(dir, 'buried.jsonl'), user('also document it') + '\n');
const bur2 = await getSessionHoverInfo('buried', PROJECT);
check('reply/context found even when the prompt is near',
  [bur2?.lastPrompt, bur2?.lastReply, bur2?.tokens], ['also document it', 'Shipped.', 100000]);

// A malformed trailing line leaves FEWER than 200 parsed records from a file
// with far more: the wider read must still run.
await write('malformed', [user('fix login'), assistant('Fixed.'), ...Array.from({ length: 250 }, () => JSON.stringify({ type: 'system', pad: 'x'.repeat(300) })), '{"broken":']);
const mal = await getSessionHoverInfo('malformed', PROJECT);
check('malformed tail still reaches the turn', [mal?.lastPrompt, mal?.lastReply], ['fix login', 'Fixed.']);

// A multi-MB prompt beyond the 200-record window: bounded, fast, and short.
const big = 'a'.repeat(4 * 1024 * 1024);
await write('big', [user(big), ...Array.from({ length: 250 }, () => JSON.stringify({ type: 'system' }))]);
const t0 = Date.now();
const b = await getSessionHoverInfo('big', PROJECT);
check('huge prompt handled under 1s', Date.now() - t0 < 1000, true);
check('huge prompt truncated to the snippet cap', b?.lastPrompt.length, 283);

await write('padded', [user(' '.repeat(5000) + 'fix login')]);
check('a prompt behind 5000 leading spaces survives the input cap', (await getSessionHoverInfo('padded', PROJECT))?.lastPrompt, 'fix login');
await write('gapped', [user('fix' + ' '.repeat(5000) + 'login')]);
check('text behind a long inner run of spaces survives too', (await getSessionHoverInfo('gapped', PROJECT))?.lastPrompt, 'fix login');

// Overlapping requests for one uncached file share a single read.
await write('burst', [user('one read please'), assistant('ok')]);
const burst = await Promise.all(Array.from({ length: 20 }, () => getSessionHoverInfo('burst', PROJECT)));
check('20 concurrent requests resolve to one shared result', burst.every((x) => x === burst[0]) && burst[0]?.lastPrompt === 'one read please', true);

check('missing transcript is null', await getSessionHoverInfo('nope', PROJECT), null);
check('path-shaped id is rejected', await getSessionHoverInfo('../../etc/passwd', PROJECT), null);
check('missing project is null', await getSessionHoverInfo('done', ''), null);

await fs.rm(TMP_HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
if (fail) process.exit(1);

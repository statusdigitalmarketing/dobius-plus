// Phone chat: each handed-back `! command` line becomes its own box with its own Copy (mobile/command-blocks.js).
// Rendered through react-markdown exactly as ChatView does. Copy goes into a shell, so anything doubtful must render
// exactly as it would without the plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkCommandBoxes, CMD_TAG } from '../../mobile/command-blocks.js';

const components = { [CMD_TAG]: ({ children }) => h('cmd', null, children) };
const render = (md, plugins) => renderToStaticMarkup(h(ReactMarkdown, { remarkPlugins: plugins, components }, md));
const withBoxes = (md) => render(md, [remarkGfm, remarkCommandBoxes]);
const plain = (md) => render(md, [remarkGfm]);
const boxes = (md) => [...withBoxes(md).matchAll(/<cmd>([\s\S]*?)<\/cmd>/g)].map((m) => m[1]);
const same = (md) => assert.equal(withBoxes(md), plain(md), JSON.stringify(md));

test('a ! line becomes a box; the prose around it stays, in order', () => {
  assert.equal(withBoxes('Run this:\n! open -a Dobius\nthen done'), '<p>Run this:</p>\n<cmd>open -a Dobius</cmd>\n<p>then done</p>');
  assert.deepEqual(boxes('`! gh run cancel 123`'), ['gh run cancel 123']);
  assert.deepEqual(boxes('! a\r\n! b'), ['a', 'b']);
  assert.deepEqual(boxes('Run this yourself:\n! echo dobius-bang-test'), ['echo dobius-bang-test']);
  assert.deepEqual(boxes('Run `make` first, then:\n! npm test'), ['npm test']);
  assert.deepEqual(boxes('! curl -fsSL https://example.com/x.sh'), ['curl -fsSL https://example.com/x.sh']);
  assert.deepEqual(boxes('**Run this:**\n! npm test'), ['npm test']);
});

test('left alone: lists, indented, prose with a bang, empty, unmatched ticks', () => {
  for (const s of ['- ! listed cmd', '  ! indented cmd', 'Wow! nice', '!  ', '', '`! no closing tick', '`! a` and more', '`! echo ok``', '! echo `date`', '! echo ok`']) same(s);
});

test('code fences, any length or kind, including one named like the box (Codex P2 x2)', () => {
  same('```sh\n! not this\n```');
  same('~~~\n! nor this\n~~~');
  same('````sh\n```\n! echo ok\n````');
  same('```dobius-cmd\n! echo ok\n```');
  assert.equal(boxes('````sh\n```\n````\n\n! echo ok').length, 1);
});

test('tables, quotes, lists and headings keep their lines (Codex P2 rounds 1 and 2)', () => {
  same('Command | Purpose\n--- | ---\n! echo ok | Print greeting');
  same('! echo ok | x\n--- | ---\na | b');
  same('> Do not run:\n! rm -rf /');
  same('- Do not run:\n! rm -rf /');
  same('1. Do not run:\n! rm -rf /');
  same('Intro\n> quoted\n! rm -rf /');
  same('! echo ok\nThis is a heading\n===');
  same('! echo ok\n---');
  assert.deepEqual(boxes('> quoted\n\n! echo ok'), ['echo ok']);
});

test('multi-line inline code, links and emphasis keep their lines (Codex P2 rounds 2 and 3)', () => {
  same('`example\n! echo ok\nend`');
  same('[Do not run\n! rm -rf /\n](https://example.com)');
  same('*Do not run\n! rm -rf /\nplease*');
  same('![alt\n! rm -rf /\n](x.png)');
});

test('continued, escaped, entity or hidden-character lines are left alone (Codex P2 rounds 1 and 2)', () => {
  same('`! echo ok \\`\nDo not run this on production.');
  same('`! printf \\\n  "%s" ok`');
  same('! printf "%s" "a\\\nb"');
  same('! git push \\\n  origin main');
  same('! git\u200b status');
  same('! git&#8203; status');
  same('! echo \\*');
  same('! echo &amp; ok');
  same('\\! echo ok');
  same('! \u00a0printf ok'); // Codex P2 round 4: trim() dropped it and Copy gave a different command
  same('! \ufeffgit status');
  same('! echo\u00a0ok');
  same('`! \u2009ls`');
});

test('raw HTML blocks that hide their contents are left alone', () => {
  same('<!--\n\n! rm -rf /\n\n-->');
  same('<pre>\n\n! rm -rf /\n\n</pre>');
});

test('a long reply with many backtick runs stays fast', () => {
  let s = 'Intro ';
  for (let n = 100; n < 800; n++) s += '`'.repeat(n) + ' x ';
  for (let i = 0; i < 20000; i++) s += '` ';
  s += '\n! echo ok';
  const t0 = performance.now();
  const plainMs = (() => { const a = performance.now(); plain(s); return performance.now() - a; })();
  const t1 = performance.now();
  withBoxes(s);
  const boxMs = performance.now() - t1;
  assert.ok(boxMs < plainMs * 2 + 50, `plugin ${boxMs} ms vs markdown alone ${plainMs} ms (${t1 - t0})`);
});

test('Tasks > Commands drops the same hidden spaces (shared rule, Codex P2 round 4)', async () => {
  const { extractCommands } = await import('../handoff-commands.js');
  assert.deepEqual(extractCommands('! \u00a0printf ok\n! \ufeffgit status\n! git\u00a0status\n! git push \\\n\u00a0origin\n! ls\ufeff\n! pwd\u00a0\n! echo ok'), ['echo ok']);
});

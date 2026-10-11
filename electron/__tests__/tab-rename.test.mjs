// dobius-tab: runs the REAL generated bash script against a local HTTP server
// and checks what reaches the bridge, plus the /tabRename body validation.
// Run: node ./electron/__tests__/tab-rename.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateTabRename, buildTabCliScript, MAX_RAW_LABEL } from '../tab-rename.js';

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const TAB_ID_RE = /^term-.+-\d+$/;

// 1. Body validation.
assert.deepEqual(validateTabRename({ tabId: 'term-/x/y-3', label: 'Fix bug' }, TAB_ID_RE), { tabId: 'term-/x/y-3', label: 'Fix bug' });
assert.ok(validateTabRename({ tabId: 'nope', label: 'x' }, TAB_ID_RE).error);
assert.ok(validateTabRename({ tabId: 'term-/x-1', label: '' }, TAB_ID_RE).error);
assert.ok(validateTabRename({ tabId: 'term-/x-1', label: '   ' }, TAB_ID_RE).error);
assert.ok(validateTabRename({ tabId: 'term-/x-1', label: 7 }, TAB_ID_RE).error);
assert.ok(validateTabRename({ tabId: 'term-/x-1', label: 'a'.repeat(MAX_RAW_LABEL + 1) }, TAB_ID_RE).error);
assert.ok(validateTabRename(null, TAB_ID_RE).error);
assert.ok(validateTabRename({ tabId: 'term-/x-1', label: '\u2733' }, TAB_ID_RE).error);
assert.ok(validateTabRename({ tabId: 'term-/x-1', label: '\u2800 * ' }, TAB_ID_RE).error);
assert.ok(!validateTabRename({ tabId: 'term-/x-1', label: '\u2733 Fix 2' }, TAB_ID_RE).error);
ok('tabRename body validation');

// 2. The script, end to end, against a server on a free port.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-tab-test-'));
const tokenFile = path.join(dir, "token with space's");
fs.writeFileSync(tokenFile, 'a'.repeat(64));
const seen = [];
let status = 200;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? '{"ok":true}' : '{"ok":false}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const script = path.join(dir, 'dobius-tab');
fs.writeFileSync(script, buildTabCliScript({ port, tokenFile }), { mode: 0o755 });

// Async spawn: a sync one would block the event loop the server needs.
const run = (args, env) => new Promise((resolve) => {
  const p = spawn(script, args, { env: { PATH: process.env.PATH, ...env } });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => resolve({ code, out, err }));
});

let r = await run(['Fix "login" bug', "it's $HOME"], { DOBIUS_TAB_ID: 'term-/p/q-2' });
assert.equal(r.code, 0, r.err);
assert.match(r.out, /tab labeled/);
assert.equal(seen.length, 1);
assert.equal(seen[0].url, '/tabRename');
assert.equal(seen[0].method, 'POST');
assert.equal(seen[0].headers.host, `127.0.0.1:${port}`);
assert.equal(seen[0].headers.authorization, `Bearer ${'a'.repeat(64)}`);
assert.match(seen[0].headers['content-type'], /^application\/json/);
assert.equal(seen[0].headers.origin, undefined);
assert.deepEqual(JSON.parse(seen[0].body), { tabId: 'term-/p/q-2', label: 'Fix "login" bug it\'s $HOME' });
ok('dobius-tab posts the caller tab id and label with the bearer token');

// 3. Outside a Dobius tab it refuses without touching the network.
r = await run(['x'], {});
assert.equal(r.code, 1);
assert.match(r.err, /DOBIUS_TAB_ID/);
r = await run([], { DOBIUS_TAB_ID: 'term-/p/q-2' });
assert.equal(r.code, 1);
assert.match(r.err, /usage/);
assert.equal(seen.length, 1);
ok('no tab id or no label: usage error, no request');

// 4. A bridge error is a non-zero exit, not a silent success.
status = 404;
r = await run(['Gone tab'], { DOBIUS_TAB_ID: 'term-/p/q-9' });
assert.notEqual(r.code, 0);
assert.doesNotMatch(r.out, /tab labeled/);
ok('bridge rejection fails the command');

// 5. Unreadable token: clear error, exit 2.
fs.rmSync(tokenFile);
r = await run(['x'], { DOBIUS_TAB_ID: 'term-/p/q-2' });
assert.equal(r.code, 2);
assert.match(r.err, /token unreadable/);
ok('missing token file is reported');

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed`);

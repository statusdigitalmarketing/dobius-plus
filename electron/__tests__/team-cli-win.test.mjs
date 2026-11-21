// dobius-team on Windows (electron/team-cli-win.mjs and its launchers in electron/team-cli.js). Platform neutral: it
// also runs in the Windows CI job, where the spawned-script test exercises real Windows pipes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { run, parseArgs, clean } from '../team-cli-win.mjs';
import { windowsTeamSh, windowsTeamConfig } from '../team-cli.js';
import { PS_TEAM_FUNCTION, loginShellSpawn } from '../../shared/new-tab.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'team-cli-win.mjs');

// A stand-in bridge: records each request and answers with whatever the test hands it.
async function bridge(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (b) => parts.push(b));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const a = answer(body);
      res.writeHead(a.status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof a.json === 'string' ? a.json : JSON.stringify(a.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

function tmpToken(value = 'tok-123') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dteam-'));
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, value);
  return { dir, file };
}

const sink = () => { let s = ''; return { stream: new Writable({ write(c, _e, cb) { s += c.toString('utf8'); cb(); } }), text: () => s }; };
const tty = () => Object.assign(Readable.from([]), { isTTY: true });
const input = (text) => Readable.from([Buffer.from(text, 'utf8')]);

async function go(argv, { port, tokenFile, stdin = tty(), env = {}, stdinWaitMs }) {
  const out = sink(); const err = sink();
  const code = await run({ argv, env, stdin, stdout: out.stream, stderr: err.stream, config: { port, tokenFile }, ...(stdinWaitMs ? { stdinWaitMs } : {}) });
  return { code, out: out.text(), err: err.text() };
}

test('parseArgs mirrors the Mac script usage', () => {
  assert.deepEqual(parseArgs(['peers']), { cmd: 'peers', arg: '' });
  assert.deepEqual(parseArgs(['send', 'Sam']), { cmd: 'send', arg: 'Sam' });
  assert.match(parseArgs(['send']).error, /^usage: dobius-team send <name\|fingerprint>/);
  assert.match(parseArgs(['reply']).error, /<id@fingerprint>/);
  assert.match(parseArgs(['approve']).error, /<request id>/);
  assert.match(parseArgs(['done']).error, /^usage: dobius-team done/);
  assert.match(parseArgs([]).error, /^usage: dobius-team peers \| inbox/);
  assert.match(parseArgs(['rm', '-rf']).error, /^usage:/);
});

test('peers: posts to the bridge with the token and the tab, prints the lines with controls removed', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: ['this PC: Zee abc', 'Sam \x1b[31mred\x1b[0m'] } }));
  const t = tmpToken('secret-token\r\n');
  try {
    const r = await go(['peers'], { port: b.port, tokenFile: t.file, env: { DOBIUS_TAB_ID: 'term-C:\\work-3' } });
    assert.equal(r.code, 0);
    assert.equal(r.out, 'this PC: Zee abc\nSam ?[31mred?[0m\n');
    assert.equal(r.err, '');
    assert.equal(b.seen.length, 1);
    const q = b.seen[0];
    assert.equal(q.method, 'POST');
    assert.equal(q.url, '/team');
    assert.equal(q.headers.host, `127.0.0.1:${b.port}`);
    assert.equal(q.headers.authorization, 'Bearer secret-token');
    assert.deepEqual(q.body, { cmd: 'peers', arg: '', text: '', tabId: 'term-C:\\work-3' });
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('send: the message comes from stdin as UTF-8, trailing line breaks dropped like $(cat)', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: ['queued abc to Sam'] } }));
  const t = tmpToken();
  try {
    const r = await go(['send', 'Sam'], { port: b.port, tokenFile: t.file, stdin: input('héllo from Zee\nline two\r\n\r\n') });
    assert.equal(r.code, 0);
    assert.equal(r.out, 'queued abc to Sam\n');
    assert.deepEqual(b.seen[0].body, { cmd: 'send', arg: 'Sam', text: 'héllo from Zee\nline two', tabId: '' });
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('send refuses a terminal stdin and an empty message, and never calls the bridge', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: [] } }));
  const t = tmpToken();
  try {
    const a = await go(['send', 'Sam'], { port: b.port, tokenFile: t.file });
    assert.equal(a.code, 1);
    assert.match(a.err, /^dobius-team: give the message on stdin/);
    const e = await go(['reply', 'x@y'], { port: b.port, tokenFile: t.file, stdin: input('\n\n') });
    assert.equal(e.code, 1);
    assert.equal(e.err, 'dobius-team: the message is empty\n');
    assert.equal(b.seen.length, 0);
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a refusal from the bridge goes to stderr, cleaned, exit 1', async () => {
  const b = await bridge(() => ({ status: 403, json: { ok: false, error: 'no team orchestrator tab is pinned\x07' } }));
  const t = tmpToken();
  try {
    const r = await go(['send', 'Sam'], { port: b.port, tokenFile: t.file, stdin: input('hi') });
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.equal(r.err, 'dobius-team: no team orchestrator tab is pinned?\n');
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('failed takes an optional reason on stdin', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: ['told Sam that abc is failed'] } }));
  const t = tmpToken();
  try {
    const none = await go(['failed', 'a@b'], { port: b.port, tokenFile: t.file });
    const why = await go(['failed', 'a@b'], { port: b.port, tokenFile: t.file, stdin: input('the build broke\n') });
    assert.equal(none.code, 0);
    assert.equal(why.code, 0);
    assert.equal(b.seen[0].body.text, '');
    assert.equal(b.seen[1].body.text, 'the build broke');
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('stdin: an empty pipe that never closes is given up on; text already arriving is waited for in full', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: ['ok'] } }));
  const t = tmpToken();
  const openEmpty = () => new Readable({ read() {} });
  const slow = () => { const r = new Readable({ read() {} }); setTimeout(() => r.push('the build '), 20); setTimeout(() => r.push('broke\n'), 150); setTimeout(() => r.push(null), 200); return r; };
  try {
    const stuck = await go(['send', 'Sam'], { port: b.port, tokenFile: t.file, stdin: openEmpty(), stdinWaitMs: 60 });
    assert.equal(stuck.code, 1);
    assert.equal(stuck.err, 'dobius-team: stdin stayed open with nothing on it for 30 s\n');
    const noReason = await go(['failed', 'a@b'], { port: b.port, tokenFile: t.file, stdin: openEmpty(), stdinWaitMs: 60 });
    assert.equal(noReason.code, 0);
    const reason = await go(['failed', 'a@b'], { port: b.port, tokenFile: t.file, stdin: slow(), stdinWaitMs: 60 });
    const msg = await go(['send', 'Sam'], { port: b.port, tokenFile: t.file, stdin: slow(), stdinWaitMs: 60 });
    assert.equal(reason.code, 0);
    assert.equal(msg.code, 0);
    assert.deepEqual(b.seen.map((q) => q.body.text), ['', 'the build broke', 'the build broke'], 'slow text is never cut off');
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('NODE_DEBUG in any case: refused before the token is read, nothing sent', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: [] } }));
  const t = tmpToken();
  try {
    for (const env of [{ NODE_DEBUG: 'net' }, { node_debug: 'http,net' }, { Node_Debug_Native: 'x' }]) {
      const r = await go(['peers'], { port: b.port, tokenFile: t.file, env });
      assert.equal(r.code, 2);
      assert.equal(r.err, `dobius-team: ${Object.keys(env)[0]} is set in this shell, and it would print the bridge token. Unset it, then run this again\n`);
    }
    const empty = await go(['peers'], { port: b.port, tokenFile: t.file, env: { NODE_DEBUG: '' } });
    assert.equal(empty.code, 0, 'an empty NODE_DEBUG turns nothing on');
    assert.equal(b.seen.length, 1);
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('the script run with NODE_DEBUG=net (no launcher) never prints the token', async () => {
  const b = await bridge(() => ({ json: { ok: true, lines: ['ok'] } }));
  const t = tmpToken('tok-SHOULD-NOT-APPEAR');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dteam-dbg-'));
  const js = path.join(dir, 'dobius-team.mjs');
  fs.copyFileSync(SCRIPT, js);
  fs.writeFileSync(path.join(dir, 'dobius-team.json'), windowsTeamConfig({ port: b.port, tokenFile: t.file }));
  try {
    const r = spawnSync(process.execPath, [js, 'peers'], { env: { ...process.env, NODE_DEBUG: 'net,http' }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout + r.stderr, /SHOULD-NOT-APPEAR/);
    assert.equal(b.seen.length, 0);
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no token, a damaged settings file, a dead bridge or a non-JSON answer each fail with a reason', async () => {
  const t = tmpToken('');
  try {
    const noTok = await go(['peers'], { port: 1, tokenFile: t.file });
    assert.equal(noTok.code, 2);
    assert.equal(noTok.err, 'dobius-team: bridge token unreadable (is Dobius+ running?)\n');
    const badCfg = await go(['peers'], { port: 'x', tokenFile: t.file });
    assert.equal(badCfg.code, 2);
    assert.match(badCfg.err, /settings file is missing or damaged/);
    fs.writeFileSync(t.file, 'tok');
    const dead = await bridge(() => ({ json: {} }));
    const deadPort = dead.port;
    await dead.close();
    const gone = await go(['peers'], { port: deadPort, tokenFile: t.file });
    assert.equal(gone.code, 1);
    assert.match(gone.err, /^dobius-team: could not reach Dobius\+ \(/);
    const html = await bridge(() => ({ json: '<html>' }));
    const notJson = await go(['inbox'], { port: html.port, tokenFile: t.file });
    await html.close();
    assert.equal(notJson.code, 1);
    assert.equal(notJson.err, 'dobius-team: Dobius+ gave an answer that is not JSON\n');
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('the script runs on its own: reads dobius-team.json beside it, pipes stdin, sets the exit code', async () => {
  const b = await bridge((body) => (body.cmd === 'send' ? { status: 403, json: { ok: false, error: 'only the team orchestrator tab can send' } } : { json: { ok: true, lines: ['no linked teammates'] } }));
  const t = tmpToken();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dteam-bin-'));
  const js = path.join(dir, 'dobius-team.mjs');
  fs.copyFileSync(SCRIPT, js);
  fs.writeFileSync(path.join(dir, 'dobius-team.json'), windowsTeamConfig({ port: b.port, tokenFile: t.file }));
  const once = (args, stdinText) => new Promise((resolve) => {
    const p = spawn(process.execPath, [js, ...args], { env: { ...process.env, DOBIUS_TAB_ID: 'tab-9' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdinText);
  });
  try {
    const peers = await once(['peers'], '');
    assert.deepEqual(peers, { code: 0, out: 'no linked teammates\n', err: '' });
    const send = await once(['send', 'Sam'], 'Grüße\n');
    assert.deepEqual(send, { code: 1, out: '', err: 'dobius-team: only the team orchestrator tab can send\n' });
    assert.deepEqual(b.seen[1].body, { cmd: 'send', arg: 'Sam', text: 'Grüße', tabId: 'tab-9' });
    const usage = await once(['nope'], '');
    assert.equal(usage.code, 1);
    assert.match(usage.err, /^usage: dobius-team peers/);
    assert.equal(b.seen.length, 2);
  } finally { await b.close(); fs.rmSync(t.dir, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Git Bash launcher: single-quoted forward-slash paths, control characters refused; no .cmd exists', async () => {
  const exe = 'C:\\Users\\Zee\\AppData\\Local\\Programs\\Dobius+\\Dobius+.exe';
  const js = 'C:\\Users\\Zee\\AppData\\Roaming\\dobius-plus\\bin\\dobius-team.mjs';
  const sh = windowsTeamSh(exe, js);
  assert.ok(sh.startsWith('#!/bin/sh\n'));
  assert.ok(sh.endsWith("\nexport ELECTRON_RUN_AS_NODE=1 MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'\nexec 'C:/Users/Zee/AppData/Local/Programs/Dobius+/Dobius+.exe' 'C:/Users/Zee/AppData/Roaming/dobius-plus/bin/dobius-team.mjs' \"$@\"\n"));
  assert.ok(windowsTeamSh("C:\\it's 100%\\x.exe", js).includes("\nexec 'C:/it'\\''s 100%/x.exe' "));
  assert.equal(windowsTeamSh('C:\\a\nb\\x.exe', js), null);
  assert.equal(windowsTeamSh('', js), null);
  assert.deepEqual(JSON.parse(windowsTeamConfig({ port: 8421, tokenFile: 'C:\\t\\voice-bridge-token' })), { port: 8421, tokenFile: 'C:\\t\\voice-bridge-token' });
  const mod = await import('../team-cli.js');
  assert.equal('windowsTeamCmd' in mod, false, 'a .cmd launcher would run through cmd.exe, which reads & | < > in a name as commands');
});

// The launcher really run by sh, with node as the "Electron" and a stand-in script that prints what reached it.
const shBin = ['/bin/sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((p) => fs.existsSync(p));
test('Git Bash launcher run by sh: NODE_DEBUG and NODE_OPTIONS in any case never reach node; arguments arrive as typed', { skip: !shBin }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dteam-sh-'));
  try {
    const stand = path.join(dir, 'stand.mjs');
    fs.writeFileSync(stand, "const e = process.env; const keys = Object.keys(e).filter((k) => /^node_(debug|debug_native|options)$/i.test(k)); process.stdout.write(JSON.stringify({ args: process.argv.slice(2), keys, run: e.ELECTRON_RUN_AS_NODE, conv: e.MSYS_NO_PATHCONV, tab: e.DOBIUS_TAB_ID }));");
    const launcher = path.join(dir, 'dobius-team');
    fs.writeFileSync(launcher, windowsTeamSh(process.execPath, stand));
    const env = { ...process.env, DOBIUS_TAB_ID: 'tab-1', NODE_DEBUG: 'net', node_debug: 'net', Node_Options: '--inspect', NODE_DEBUG_NATIVE: 'x' };
    const r = spawnSync(shBin, [launcher, 'send', '/Sam', 'two words', "it's"], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepEqual(got.keys, [], 'every case of NODE_DEBUG, NODE_DEBUG_NATIVE and NODE_OPTIONS is cleared');
    assert.deepEqual(got.args, ['send', '/Sam', 'two words', "it's"]);
    assert.equal(got.run, '1');
    assert.equal(got.conv, '1');
    assert.equal(got.tab, 'tab-1', 'the tab id still reaches the script');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every PowerShell tab defines the dobius-team function, and the start command stays under the Windows limit', () => {
  const r = loginShellSpawn('C:\\Program Files\\PowerShell\\7\\pwsh.exe', null);
  const script = Buffer.from(r.args[r.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.ok(script.includes(PS_TEAM_FUNCTION));
  assert.match(PS_TEAM_FUNCTION, /^if \(\$env:DOBIUS_TEAM_CLI_JS -and \$env:DOBIUS_ELECTRON_EXE\) \{ function global:dobius-team \{/);
  assert.doesNotMatch(PS_TEAM_FUNCTION, /cmd(\.exe)?\b/);
  // CreateProcess caps a command line at 32767 characters.
  assert.ok(r.args.join(' ').length + 60 < 32767, `start command is ${r.args.join(' ').length} characters`);
});

// Windows only (CI): the real PowerShell, 5.1 and 7 when present, calling the function with a stand-in script that
// prints what it got and exits 3, in place of dobius-team.mjs.
test('PowerShell dobius-team function: arguments, UTF-8 stdin and output, exit code, env put back', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-psteam-'));
  try {
    const stand = path.join(dir, 'team.mjs');
    fs.writeFileSync(stand, "let inp = Buffer.alloc(0); const fin = () => { process.stdout.write(JSON.stringify({ args: process.argv.slice(2), run: process.env.ELECTRON_RUN_AS_NODE, debug: process.env.NODE_DEBUG ?? null, tty: !!process.stdin.isTTY, inp: inp.toString('utf8') }) + '\\n'); process.exit(3); }; if (process.stdin.isTTY) fin(); else { process.stdin.on('data', (d) => { inp = Buffer.concat([inp, d]); }); process.stdin.on('end', fin); }");
    const body = `${PS_TEAM_FUNCTION}; $env:NODE_DEBUG = 'net'; $r = dobius-team send 'Max&Co' 'two words' 'Sam "PC"'; "EXIT=$LASTEXITCODE"; "OUT=$r"; "AFTER=[$env:ELECTRON_RUN_AS_NODE]"; $env:ELECTRON_RUN_AS_NODE = 'keep'; $p = ('h' + [char]0xe9 + 'llo'), 'line two' | dobius-team reply 'a@b'; "PIPED=$p"; "KEPT=[$env:ELECTRON_RUN_AS_NODE]"`;
    const env = { ...process.env, DOBIUS_TEAM_CLI_JS: stand, DOBIUS_ELECTRON_EXE: process.execPath };
    delete env.ELECTRON_RUN_AS_NODE;
    const shells = ['powershell.exe', 'pwsh.exe'].filter((sh) => spawnSync(sh, ['-NoProfile', '-Command', 'exit 0']).status === 0);
    assert.ok(shells.length > 0);
    for (const sh of shells) {
      const r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-Command', body], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const out = r.stdout.replace(/\r/g, '');
      const line = (k) => out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
      assert.equal(line('EXIT'), '3', `${sh}: ${out} ${r.stderr}`);
      const got = JSON.parse(line('OUT'));
      assert.deepEqual(got.args, ['send', 'Max&Co', 'two words', 'Sam "PC"'], `${sh}: an & or a quote in a name is just a character`);
      assert.equal(got.debug, null, `${sh}: NODE_DEBUG never reaches the script (it would log the token)`);
      assert.equal(got.run, '1', sh);
      assert.equal(line('AFTER'), '[]', `${sh}: ELECTRON_RUN_AS_NODE must not stay set`);
      const piped = JSON.parse(line('PIPED'));
      assert.deepEqual(piped.args, ['reply', 'a@b'], sh);
      assert.deepEqual(piped.inp.replace(/\r/g, '').split('\n').filter(Boolean), ['h\u00e9llo', 'line two'], `${sh}: piped text arrives as UTF-8`);
      assert.equal(line('KEPT'), '[keep]', `${sh}: a value the person had set is put back`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clean leaves ordinary text alone', () => {
  assert.equal(clean('ok: Zee \u00e9 \u4f60\u597d'), 'ok: Zee \u00e9 \u4f60\u597d');
  assert.equal(clean('a\u2028b\u0085c'), 'a?b?c');
});

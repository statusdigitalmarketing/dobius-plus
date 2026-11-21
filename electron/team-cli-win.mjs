// dobius-team on Windows: the same command as the Mac's bash script (electron/team-cli.js), as a small node script.
// Windows has no bash, python3 or curl to count on, so Dobius copies this file to <userData>/bin and runs it under its
// own Electron binary in node mode (ELECTRON_RUN_AS_NODE) through two launchers there: dobius-team.cmd (PowerShell,
// cmd.exe) and an extensionless dobius-team sh script (Git Bash, which Claude Code's Bash tool uses on Windows).
// The port and the bridge token's path come from dobius-team.json beside this file, so no launcher quotes them.
//
// Same rules as the Mac script: the message is read from stdin only (never argv, so never in the process list), the
// token never leaves this process except in the Authorization header to 127.0.0.1, and nothing printed carries a
// control character. Node builtins only: this runs outside the app bundle.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: dobius-team peers | inbox | send <name|fingerprint> | reply <id@fingerprint>   (text on stdin) | approve <request id> | show|release|done|failed <id@fingerprint>';
const STDIN_MAX = 1024 * 1024; // the bridge keeps 8000 characters of a message; never buffer more than 1MB of input
const REPLY_MAX = 4 * 1024 * 1024; // a bridge answer is a few KB; cap what is buffered anyway
const STDIN_WAIT_MS = 30000; // a stdin that stays open with NOTHING on it (a tool that never closes it) is given up on

// Never print a control character into a terminal (an echoed argument or a teammate's text could carry escapes).
export const clean = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?');

/** What the command line asks for, or { error } with the usage line to print. */
export function parseArgs(argv) {
  const [cmd = '', arg = ''] = argv;
  if (cmd === 'peers' || cmd === 'inbox') return { cmd, arg };
  if (cmd === 'send' || cmd === 'reply') {
    return arg ? { cmd, arg } : { error: `usage: dobius-team ${cmd} <${cmd === 'send' ? 'name|fingerprint' : 'id@fingerprint'}> (text on stdin)` };
  }
  if (cmd === 'approve') return arg ? { cmd, arg } : { error: 'usage: dobius-team approve <request id>' };
  if (['show', 'release', 'done', 'failed'].includes(cmd)) return arg ? { cmd, arg } : { error: `usage: dobius-team ${cmd} <id@fingerprint>` };
  return { error: USAGE };
}

// All of stdin as UTF-8, with trailing line breaks dropped (as bash's $(cat) does). Null when stdin is a terminal.
// optional (failed's reason): a stdin that stays empty and open counts as no reason instead of an error.
function readStdin(stdin, optional = false, waitMs = STDIN_WAIT_MS) {
  if (stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    const done = (fn, v) => { clearTimeout(timer); stdin.removeAllListeners('data'); stdin.removeAllListeners('end'); stdin.removeAllListeners('error'); fn(v); };
    // Only while nothing has arrived: once text is coming, wait for its end as the Mac script does, so a slow writer's
    // text (a failure reason) is never cut off or dropped.
    const timer = setTimeout(() => { stdin.pause(); if (optional) done(resolve, ''); else done(reject, new Error('stdin stayed open with nothing on it for 30 s')); }, waitMs);
    stdin.on('data', (b) => {
      clearTimeout(timer);
      size += b.length;
      if (size > STDIN_MAX) { stdin.pause(); done(reject, new Error('the message is over 1 MB')); return; }
      parts.push(b);
    });
    stdin.on('end', () => done(resolve, Buffer.concat(parts).toString('utf8').replace(/(\r?\n)+$/, '')));
    stdin.on('error', (e) => done(reject, e));
  });
}

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: '/team', method: 'POST', agent: false, timeout: 30000,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      const parts = [];
      let size = 0;
      res.on('data', (b) => { size += b.length; if (size > REPLY_MAX) { req.destroy(new Error('answer too large')); return; } parts.push(b); });
      res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      res.on('error', reject);
    });
    // Set on the request, not in the options: the options object is handed on to net.connect, whose debug log prints it.
    req.setHeader('Authorization', `Bearer ${token}`);
    req.on('timeout', () => req.destroy(new Error('no answer from Dobius+ in 30 s')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Runs one command. Returns the exit code; writes only to the given streams. */
export async function run({ argv, env, stdin, stdout, stderr, config, stdinWaitMs = STDIN_WAIT_MS }) {
  const fail = (msg, code = 1) => { stderr.write(`dobius-team: ${clean(msg)}\n`); return code; };
  const a = parseArgs(argv);
  if (a.error) { stderr.write(`${a.error}\n`); return 1; }
  // Node turned on its debug logging from NODE_DEBUG before this script started, and NODE_DEBUG=net prints the request,
  // token included. The launchers clear it, but a launcher cannot be relied on (another shell, a PATH without env or
  // sed), so refuse here, before the token is read. Any case: Windows reads variable names in any case.
  const dbg = Object.keys(env).find((k) => /^node_debug(_native)?$/i.test(k) && env[k]);
  if (dbg) return fail(`${dbg} is set in this shell, and it would print the bridge token. Unset it, then run this again`, 2);
  const port = Number(config?.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof config?.tokenFile !== 'string') return fail('its settings file is missing or damaged (restart Dobius+)', 2);
  let token;
  try { token = fs.readFileSync(config.tokenFile, 'utf8').replace(/[\r\n]+$/, ''); } catch { token = ''; }
  if (!token) return fail('bridge token unreadable (is Dobius+ running?)', 2);
  let text = '';
  try {
    if (a.cmd === 'send' || a.cmd === 'reply') {
      const t = await readStdin(stdin, false, stdinWaitMs);
      if (t === null) return fail('give the message on stdin (a heredoc or a file), not as an argument');
      if (!t) return fail('the message is empty');
      text = t;
    } else if (a.cmd === 'failed') {
      text = (await readStdin(stdin, true, stdinWaitMs)) || ''; // an optional reason
    }
  } catch (e) { return fail(e.message); }
  let raw;
  try { raw = await post(port, token, { cmd: a.cmd, arg: a.arg, text, tabId: env.DOBIUS_TAB_ID || '' }); }
  catch (e) { return fail(`could not reach Dobius+ (${e.message})`); }
  let r;
  try { r = JSON.parse(raw); } catch { return fail('Dobius+ gave an answer that is not JSON'); }
  if (!r || !r.ok) return fail(r?.error || 'failed');
  for (const line of Array.isArray(r.lines) ? r.lines : []) stdout.write(`${clean(line)}\n`);
  return 0;
}

// Run directly (not imported by a test): read dobius-team.json beside this file and go.
// Compared as real paths: node loads the script by its real path (a temp folder behind a symlink, a Windows junction or
// short name would otherwise never match), and case-insensitively on Windows.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(real(process.argv[1]), real(fileURLToPath(import.meta.url)))) {
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dobius-team.json'), 'utf8')); } catch { config = null; }
  const code = await run({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, config });
  // Exit once both streams have flushed (a pipe on Windows is asynchronous).
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

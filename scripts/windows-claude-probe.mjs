// Diagnostic for the Windows build (CI only): start the real Claude Code in a
// ConPTY, without logging in, and print what it writes to its own session
// record (<home>/.claude/sessions/<pid>.json) next to the creation time
// Windows reports for that pid. Confirms the procStartFt format win-proc.js
// matches against. Prints field names and the two times only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pty from 'node-pty';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = path.join(os.tmpdir(), 'claude-probe');
fs.mkdirSync(dir, { recursive: true });
const sessions = path.join(os.homedir(), '.claude', 'sessions');
const before = new Set(fs.existsSync(sessions) ? fs.readdirSync(sessions) : []);

const term = pty.spawn('cmd.exe', ['/c', 'claude'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: dir, env: process.env });
let screen = '';
term.onData((d) => {
  screen += d;
  if (d.includes('\x1b[6n')) term.write('\x1b[1;1R');
  if (/\x1b\]1[01];\?/.test(d)) term.write('\x1b]10;rgb:dddd/dddd/dddd\x1b\\\x1b]11;rgb:1111/1111/1111\x1b\\');
});
await sleep(20000);
const after = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
const fresh = after.filter((f) => !before.has(f));
console.log('session records written:', fresh.length ? fresh.join(', ') : 'none');
for (const f of fresh) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8'));
    console.log('fields:', Object.keys(rec).join(', '));
    console.log('procStart:', JSON.stringify(rec.procStart), 'procStartFt:', JSON.stringify(rec.procStartFt), typeof rec.procStartFt);
    const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(rec.pid)}").CreationDate.ToFileTimeUtc()`;
    const cim = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim();
    console.log('CIM FILETIME for that pid:', cim);
    if (/^\d+$/.test(String(rec.procStartFt)) && /^\d+$/.test(cim)) console.log('difference (100ns units):', String(BigInt(String(rec.procStartFt)) - BigInt(cim)));
  } catch (e) { console.log('could not read', f, e.message); }
}
const plain = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\s+/g, ' ');
console.log('screen tail:', plain.slice(-300));
try { term.kill(); } catch { /* gone */ }
process.exit(0);

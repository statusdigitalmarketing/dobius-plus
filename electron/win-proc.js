// Windows process table (Windows build, 2026-11-06). macOS reads processes with
// ps, pgrep and lsof, none of which exist on Windows. Here one PowerShell CIM
// query returns every process with its parent, command line and creation time,
// and the terminal code asks it the same questions it asks ps on the Mac.
//
// Creation time comes back as a Windows FILETIME (100ns ticks since 1601),
// because that is what Claude Code writes into its own session record on
// Windows (`procStartFt` in <configDir>/sessions/<pid>.json), so a tab's claude
// is matched to its record exactly, as procStart is on the Mac.
//
// ponytail: one PowerShell per table read (~0.3 to 1s), cached for TABLE_MS
// and shared by concurrent callers. Upgrade path: a native module reading
// NtQuerySystemInformation if polling ever shows up in CPU.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { isClaudeEntrypoint } from './claude-argv.js';

const TABLE_MS = 1500;
// FILETIME of the Unix epoch.
const EPOCH_FT = 116444736000000000n;

// Passed as -EncodedCommand (UTF-16LE base64): PowerShell 5.1 mis-parses
// quotes inside a -Command argument that Node has escaped.
export const TABLE_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue'; "
  + '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
  + 'Get-CimInstance Win32_Process | ForEach-Object { '
  + '$ft = 0; if ($_.CreationDate) { $ft = $_.CreationDate.ToFileTimeUtc() }; '
  + '$c = [string]$_.CommandLine; $c = $c -replace "[`t`r`n]", " "; '
  + '"{0}`t{1}`t{2}`t{3}`t{4}" -f $_.ProcessId, $_.ParentProcessId, $ft, $_.Name, $c }';
export const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Pure: the script's tab-separated lines as
 * [{ pid, ppid, startFt (BigInt|null), startedAt (ms|null), name, command }].
 */
export function parseWinTable(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.split('\t');
    if (f.length < 5) continue;
    const pid = Number(f[0]);
    const ppid = Number(f[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    let startFt = null;
    if (/^\d{1,20}$/.test(f[2]) && f[2] !== '0') startFt = BigInt(f[2]);
    rows.push({
      pid,
      ppid,
      startFt,
      startedAt: startFt === null ? null : ftToMs(startFt),
      name: f[3],
      command: f.slice(4).join('\t'),
    });
  }
  return rows;
}

/**
 * Two FILETIMEs (digit strings, numbers or BigInts) for the same process start:
 * within 1ms. Windows reports creation time to the microsecond through CIM,
 * while a process reading its own start (GetProcessTimes) gets 100ns, so an
 * exact match would miss. A pid plus a start within 1ms names one process.
 */
export function sameFiletime(a, b) {
  if (!/^\d{1,20}$/.test(String(a ?? '')) || !/^\d{1,20}$/.test(String(b ?? ''))) return false;
  const d = BigInt(String(a)) - BigInt(String(b));
  return (d < 0n ? -d : d) <= 10000n;
}

/**
 * The FILETIME start a Claude session record gives for its own process, as a
 * digit string, or null. Claude Code on Windows (seen on 2.1.319) writes it as
 * `procStart` (a FILETIME digit string), not `procStartFt`, so reading only
 * `procStartFt` never matched and no tab ever linked to its session. A
 * `procStart` that is not all digits is the macOS `ps lstart` text, never a
 * FILETIME.
 */
export function recordStartFiletime(rec) {
  if (!rec || typeof rec !== 'object') return null;
  for (const v of [rec.procStartFt, rec.procStart]) {
    if (v != null && /^\d{1,20}$/.test(String(v))) return String(v);
  }
  return null;
}

export function ftToMs(ft) {
  try {
    const n = typeof ft === 'bigint' ? ft : BigInt(String(ft));
    return Number((n - EPOCH_FT) / 10000n);
  } catch { return null; }
}

let cached = null; // { at, rows } | { at, pending }

/** Every process, or null when PowerShell could not be read. */
export async function winProcessTable({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cached && now - cached.at < TABLE_MS) return cached.rows ?? cached.pending;
  const pending = new Promise((resolve) => {
    execFile(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(TABLE_SCRIPT)], {
      timeout: 8000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        console.warn('[win-proc] process table read failed:', err.code || err.message);
        resolve(null);
        return;
      }
      resolve(parseWinTable(stdout));
    });
  });
  const entry = { at: now, pending };
  cached = entry;
  const rows = await pending;
  if (cached === entry) cached = rows ? { at: Date.now(), rows } : null;
  return rows;
}

/**
 * Pure: split a Windows command line into argv the way the C runtime does
 * (CommandLineToArgvW rules: quotes group, 2n backslashes before a quote give
 * n backslashes, 2n+1 give n and a literal quote).
 */
export function splitWinCommandLine(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '';
  let inQ = false;
  let any = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      let n = 0;
      while (s[i] === '\\') { n += 1; i += 1; }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) { cur += '"'; any = true; } else { inQ = !inQ; any = true; }
      } else {
        cur += '\\'.repeat(n);
        any = true;
        i -= 1;
      }
    } else if (ch === '"') {
      if (inQ && s[i + 1] === '"') { cur += '"'; i += 1; } else inQ = !inQ;
      any = true;
    } else if ((ch === ' ' || ch === '\t') && !inQ) {
      if (any) { out.push(cur); cur = ''; any = false; }
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** Lowercased executable base name without .exe/.cmd/.bat/.com. */
export function winExeBase(tok) {
  return path.win32.basename(String(tok || '')).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

// A process row that may be Claude though it could not be read as Claude: an executable named claude, or a JS runtime
// whose command names claude or could not be read. An unrelated program with claude only in an argument
// (`notepad.exe C:\tmp\claude.txt`) is not (Codex, PR 7).
export function winMayBeClaude(row) {
  const base = winExeBase(row?.name || '');
  if (/claude/i.test(base)) return true;
  return ['node', 'bun', 'deno'].includes(base) && (!row?.command || /claude/i.test(row.command));
}

// When no Claude was found among a shell's dated programs (`progs`, from shellPrograms): could one still be there? A
// program that may be Claude but could not be read as Claude, or any row under the shell (two levels) that the dated
// list left out (no creation time on it or on its launcher, such as an undated cmd running claude.cmd with a dated
// node.exe under it) that is or may be Claude (Codex, PR 7).
export function winShellMayHoldClaude(rows, shellPid, progs) {
  if (progs.some((r) => winMayBeClaude(r) && !winClaudeCommand(r.command))) return true;
  const kids = new Set(rows.filter((r) => r.ppid === shellPid).map((r) => r.pid));
  return rows.some((r) => (r.ppid === shellPid || kids.has(r.ppid)) && !progs.includes(r) && (winMayBeClaude(r) || winClaudeCommand(r.command)));
}

/**
 * The script node runs, from its argv (argv[0] is node), or null. Strict: the
 * script must come straight after node, the only shape npm's Windows launchers
 * use. A flag first is refused rather than parsed: node has value-taking
 * flags (--title X) and string-running ones (-e, -pe, --eval=) in many
 * spellings, and misreading one makes an unrelated process look like Claude.
 */
function nodeScript(argv) {
  if (argv.length < 2 || argv[1].startsWith('-')) return null;
  return { script: argv[1], rest: argv.slice(2) };
}

/**
 * Pure: is this Windows command line Claude Code? { sessionId } when it is
 * (sessionId from --resume/-r, else null), null otherwise. Accepts the native
 * claude.exe (and its versions\<v> binary) and node running the npm cli.js.
 */
export function winClaudeCommand(command) {
  const argv = splitWinCommandLine(command);
  if (!argv.length) return null;
  const base = winExeBase(argv[0]);
  let rest = null;
  const fwd = (p) => String(p).replace(/\\/g, '/');
  if (base === 'claude' || isClaudeEntrypoint(fwd(argv[0]).replace(/\.exe$/i, ''))) rest = argv.slice(1);
  else if (base === 'node' || base === 'bun') {
    const n = nodeScript(argv);
    if (n && isClaudeEntrypoint(fwd(n.script))) rest = n.rest;
  }
  if (!rest) return null;
  let sessionId = null;
  for (let i = 0; i < rest.length - 1; i += 1) {
    if ((rest[i] === '--resume' || rest[i] === '-r') && /^[a-zA-Z0-9][\w-]{1,99}$/.test(rest[i + 1])) { sessionId = rest[i + 1]; break; }
  }
  return { sessionId };
}

/**
 * Pure: is this Windows command line an interactive Codex? The same
 * { sessionId, cd } as parseCodexCommand on the Mac, or null.
 */
export function winCodexCommand(command, parseCodexCommand) {
  const argv = splitWinCommandLine(command);
  if (!argv.length) return null;
  const base = winExeBase(argv[0]);
  let rest = null;
  if (base === 'codex') rest = argv.slice(1);
  else if (base === 'node') {
    const n = nodeScript(argv);
    if (n && /[/\\]@openai[/\\]codex[/\\]bin[/\\]codex\.js$/i.test(n.script)) rest = n.rest;
  }
  if (!rest) return null;
  // parseCodexCommand splits on whitespace; give it tokens without spaces.
  if (rest.some((a) => /\s/.test(a))) {
    const safe = rest.map((a) => (/\s/.test(a) ? '_' : a));
    const parsed = parseCodexCommand(['codex', ...safe].join(' '));
    if (!parsed) return null;
    const cdAt = rest.findIndex((a) => a === '-C' || a === '--cd');
    return { ...parsed, cd: cdAt >= 0 ? rest[cdAt + 1] || null : parsed.cd };
  }
  return parseCodexCommand(['codex', ...rest].join(' '));
}

/**
 * Pure: a cmd.exe that runs one command and exits (`cmd /d /s /c ...`, how
 * PowerShell starts npm's .cmd launchers), read from its own switches: the
 * first /c or /k decides, and any non-switch word before one means neither.
 */
export function isCmdLauncher(command) {
  for (const t of splitWinCommandLine(command).slice(1)) {
    if (/^\/c$/i.test(t)) return true;
    if (/^\/k$/i.test(t)) return false;
    if (!/^\/[a-z](:.*)?$/i.test(t)) return false;
  }
  return false;
}

/** Pure helpers over a table: children by parent pid. */
export function childrenIndex(rows) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  return kids;
}

/**
 * Pure: every process under `root` (not root itself), breadth first. Windows
 * reuses pids and keeps a dead parent's pid in ParentProcessId, so a child is
 * only taken when it started after its parent.
 */
export function descendants(rows, root) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const kids = childrenIndex(rows);
  const out = [];
  if (byPid.get(root)?.startFt == null) return out;
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    const parent = byPid.get(pid);
    for (const k of kids.get(pid) || []) {
      if (seen.has(k.pid)) continue;
      if (parent?.startFt == null || k.startFt == null || k.startFt < parent.startFt) continue;
      seen.add(k.pid);
      out.push(k);
      queue.push(k.pid);
    }
  }
  return out;
}

/**
 * Pure: the programs a tab's shell is running, as the user sees them: its
 * direct children, looking through cmd.exe wrappers (npm's claude.cmd starts
 * node under cmd) and skipping console hosts.
 */
export function shellPrograms(rows, shellPid) {
  const kids = childrenIndex(rows);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const shell = byPid.get(shellPid);
  if (!shell || shell.startFt == null) return [];
  const after = (parent, k) => parent?.startFt != null && k.startFt != null && k.startFt >= parent.startFt;
  const out = [];
  for (const k of kids.get(shellPid) || []) {
    if (!after(shell, k)) continue;
    const b = winExeBase(k.name);
    if (b === 'conhost' || b === 'openconsole') continue;
    if (b === 'cmd' && isCmdLauncher(k.command)) {
      const inner = (kids.get(k.pid) || []).filter((g) => after(k, g) && !['conhost', 'openconsole'].includes(winExeBase(g.name)));
      if (inner.length) { out.push(...inner); continue; }
    }
    out.push(k);
  }
  return out;
}

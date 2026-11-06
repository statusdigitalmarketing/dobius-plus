// Windows build pieces that can be checked on any OS: paths, the process
// table parser and command-line recognizers, the PowerShell launcher, the
// Windows keymap, and presence matching by FILETIME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsPath, isInsidePath, baseName } from '../../shared/platform.js';
import {
  parseWinTable, splitWinCommandLine, isCmdLauncher, winClaudeCommand, winCodexCommand, ftToMs,
  shellPrograms, descendants, TABLE_SCRIPT, encodePs,
} from '../win-proc.js';
import { parseCodexCommand } from '../codex-sessions.js';
import { loginShellSpawn, isPowerShell } from '../../shared/new-tab.js';
import { winToMacShortcut, winTerminalKey } from '../../shared/win-keys.js';
import { presenceOf } from '../claude-presence.js';

test('isAbsPath follows the platform', () => {
  assert.equal(isAbsPath('/Users/a', 'darwin'), true);
  assert.equal(isAbsPath('C:\\Users\\a', 'darwin'), false);
  assert.equal(isAbsPath('C:\\Users\\a', 'win32'), true);
  assert.equal(isAbsPath('c:/x', 'win32'), true);
  assert.equal(isAbsPath('C:x', 'win32'), false);
  assert.equal(isAbsPath('\\\\srv\\share\\x', 'win32'), false); // UNC: refused
  assert.equal(isAbsPath('/Users/a', 'win32'), false);
  assert.equal(isAbsPath('rel\\x', 'win32'), false);
  assert.equal(isAbsPath('', 'win32'), false);
});

test('isInsidePath is by segment, case-insensitive on Windows', () => {
  assert.equal(isInsidePath('/a/b/c', '/a/b', 'darwin'), true);
  assert.equal(isInsidePath('/a/bc', '/a/b', 'darwin'), false);
  assert.equal(isInsidePath('/a/b', '/a/b/', 'darwin'), true);
  assert.equal(isInsidePath('C:\\Code\\App\\src', 'c:\\code\\app', 'win32'), true);
  assert.equal(isInsidePath('C:/Code/App2', 'C:\\Code\\App', 'win32'), false);
  assert.equal(isInsidePath('C:\\x', 'C:\\', 'win32'), true);
  assert.equal(baseName('C:\\Users\\jacob\\code\\app', 'win32'), 'app');
  assert.equal(baseName('/Users/x/client\\api', 'darwin'), 'client\\api');
  assert.equal(baseName('/Users/x/app/'), 'app');
});

test('splitWinCommandLine follows the C runtime rules', () => {
  assert.deepEqual(splitWinCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\a b\\cli.js" --resume x'),
    ['C:\\Program Files\\nodejs\\node.exe', 'C:\\a b\\cli.js', '--resume', 'x']);
  assert.deepEqual(splitWinCommandLine('a\\\\"b c" d'), ['a\\b c', 'd']);
  assert.deepEqual(splitWinCommandLine('say \\"hi\\"'), ['say', '"hi"']);
  assert.deepEqual(splitWinCommandLine('x ""'), ['x', '']);
  assert.deepEqual(splitWinCommandLine(''), []);
});

test('winClaudeCommand: native exe, npm under node, and lookalikes', () => {
  assert.deepEqual(winClaudeCommand('"C:\\Users\\j\\.local\\bin\\claude.exe"'), { sessionId: null });
  assert.deepEqual(winClaudeCommand('C:\\Users\\j\\.local\\bin\\claude.exe --resume 1b2c3d4e-0000-4000-8000-000000000000'),
    { sessionId: '1b2c3d4e-0000-4000-8000-000000000000' });
  assert.deepEqual(winClaudeCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" -r abc12'),
    { sessionId: 'abc12' });
  assert.equal(winClaudeCommand('node C:\\tools\\watch.js C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), null);
  assert.equal(winClaudeCommand('node -e "x" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), null);
  assert.equal(winClaudeCommand('node "--eval=setInterval(()=>{},1000)" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume 11111111-1111-4111-8111-111111111111'), null);
  assert.equal(winClaudeCommand('node -pe 1 C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), null);
  assert.equal(winClaudeCommand('node "-esetInterval(()=>{},1000)" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'), null);
  assert.equal(winClaudeCommand('node --title C:\\tools\\claude-code\\cli.js C:\\tools\\watcher.js --resume 11111111-1111-4111-8111-111111111111'), null);
  assert.equal(winClaudeCommand('notepad.exe claude.md'), null);
  assert.equal(winClaudeCommand('C:\\x\\claudette.exe'), null);
});

test('winCodexCommand reads codex.exe and npm codex.js', () => {
  assert.deepEqual(winCodexCommand('C:\\npm\\codex.exe resume 0199a1b2-0000-7000-8000-000000000000', parseCodexCommand),
    { sessionId: '0199a1b2-0000-7000-8000-000000000000', cd: null });
  assert.deepEqual(winCodexCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js --cd "C:\\My Code\\app"', parseCodexCommand),
    { sessionId: null, cd: 'C:\\My Code\\app' });
  assert.equal(winCodexCommand('C:\\npm\\codex.exe exec "hi"', parseCodexCommand), null);
  assert.equal(winCodexCommand('node C:\\x\\other.js', parseCodexCommand), null);
});

const FT = (ms) => String(BigInt(ms) * 10000n + 116444736000000000n);

test('parseWinTable and tree helpers', () => {
  const t0 = Date.UTC(2026, 10, 6, 12, 0, 0);
  const text = [
    `100\t1\t${FT(t0)}\tpowershell.exe\tpowershell.exe -NoLogo`,
    `101\t100\t${FT(t0 + 10)}\tconhost.exe\tconhost.exe 0x4`,
    `102\t100\t${FT(t0 + 2000)}\tcmd.exe\tC:\\Windows\\system32\\cmd.exe /c claude.cmd`,
    `103\t102\t${FT(t0 + 2100)}\tnode.exe\t"node.exe" "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"`,
    `104\t100\t${FT(t0 - 5000)}\told.exe\told.exe`, // a reused parent pid: started before the shell
    'garbage line',
    '\r',
  ].join('\r\n');
  const rows = parseWinTable(text);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].startedAt, t0);
  assert.equal(ftToMs(FT(t0)), t0);
  const progs = shellPrograms(rows, 100);
  assert.deepEqual(progs.map((r) => r.pid), [103]);
  assert.deepEqual(descendants(rows, 100).map((r) => r.pid).sort(), [101, 102, 103]);
  // A child whose parent row is missing (the shell pid was reused) is nobody's.
  assert.deepEqual(shellPrograms(rows.filter((r) => r.pid !== 100), 100), []);
  assert.deepEqual(descendants(rows.filter((r) => r.pid !== 100), 100), []);
  // An interactive cmd (no /c) is not looked through: `start` opens its own console.
  const interactive = parseWinTable([
    `200\t1\t${FT(t0)}\tpowershell.exe\tpowershell.exe`,
    `201\t200\t${FT(t0 + 10)}\tcmd.exe\tcmd.exe`,
    `202\t201\t${FT(t0 + 20)}\tclaude.exe\tC:\\tools\\claude.exe --resume x1`,
  ].join('\n'));
  assert.deepEqual(shellPrograms(interactive, 200).map((r) => r.pid), [201]);
  assert.equal(isCmdLauncher('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\npm\\claude.cmd" --resume x"'), true);
  assert.equal(isCmdLauncher('cmd.exe /c claude.cmd'), true);
  assert.equal(isCmdLauncher('cmd.exe /k "echo /c ready"'), false);
  assert.equal(isCmdLauncher('cmd.exe'), false);
  assert.equal(isCmdLauncher('cmd.exe echo /c'), false);
});

test('the table script round-trips through -EncodedCommand', () => {
  assert.equal(Buffer.from(encodePs(TABLE_SCRIPT), 'base64').toString('utf16le'), TABLE_SCRIPT);
  assert.match(TABLE_SCRIPT, /Get-CimInstance Win32_Process/);
});

test('PowerShell new tabs: allowlisted tool from env, nothing interpolated', () => {
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(isPowerShell(ps), true);
  assert.equal(isPowerShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), true);
  assert.equal(isPowerShell('/bin/zsh'), false);
  assert.deepEqual(loginShellSpawn(ps, null), { args: ['-NoLogo'], env: {} });
  const r = loginShellSpawn(ps, 'claude');
  assert.deepEqual(r.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
  assert.deepEqual(r.env, { DOBIUS_NEW_TAB_TOOL: 'claude' });
  const script = Buffer.from(r.args[3], 'base64').toString('utf16le');
  assert.match(script, /if \(\$__dt -eq 'claude'\) \{ __dobius_run claude \}/);
  assert.doesNotMatch(script, /Invoke-Expression|iex /);
  // A tool name outside the allowlist starts a plain shell.
  assert.deepEqual(loginShellSpawn(ps, 'calc'), { args: ['-NoLogo'], env: {} });
  // The Mac path is unchanged.
  assert.deepEqual(loginShellSpawn('/bin/zsh', null), { args: ['-l'], env: {} });
});

test('Windows keymap: Ctrl+Shift app shortcuts, terminal keeps Ctrl', () => {
  const k = (key, o = {}) => ({ type: 'keydown', key, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, preventDefault() {}, ...o });
  assert.equal(winToMacShortcut(k('t')), null); // Ctrl+T is Claude's
  assert.equal(winToMacShortcut(k('T', { shiftKey: true })).key, 't');
  assert.equal(winToMacShortcut(k('W', { shiftKey: true })).key, 'w');
  assert.equal(winToMacShortcut(k('N', { shiftKey: true })).shiftKey, true);
  const m = winToMacShortcut(k('M', { shiftKey: true }));
  assert.deepEqual([m.key, m.shiftKey], ['c', true]);
  assert.equal(winToMacShortcut(k('Tab')).key, ']');
  assert.equal(winToMacShortcut(k('Tab', { shiftKey: true })).key, '[');
  assert.equal(winToMacShortcut(k('3')).key, '3');
  assert.equal(winToMacShortcut(k('b')), null);
  assert.equal(winToMacShortcut({ ...k('T', { shiftKey: true }), altKey: true }), null);
  assert.equal(winTerminalKey(k('c'), false), null); // interrupt
  assert.equal(winTerminalKey(k('c'), true), 'copy');
  assert.equal(winTerminalKey(k('C', { shiftKey: true }), false), 'copy');
  assert.equal(winTerminalKey(k('v'), false), 'paste');
  assert.equal(winTerminalKey(k('R', { shiftKey: true }), false), 'app');
  assert.equal(winTerminalKey(k('F', { shiftKey: true }), false), 'app');
  assert.equal(winTerminalKey(k('r'), false), null);
});

test('presence matches a Windows record by FILETIME, never by a reused pid', async () => {
  const ft = '133123456789012345';
  const rec = { pid: 42, sessionId: '1b2c3d4e-0000-4000-8000-000000000000', procStartFt: ft, cwd: 'C:\\Code\\app' };
  const read = async () => JSON.stringify(rec);
  const hit = await presenceOf({ pid: 42, startFt: ft, startedAt: ftToMs(ft) }, '/cfg', read);
  assert.equal(hit.sessionId, rec.sessionId);
  // CIM gives microseconds, Claude may record 100ns: a few ticks apart is the same start.
  assert.equal((await presenceOf({ pid: 42, startFt: '133123456789012340', startedAt: 1 }, '/cfg', read))?.sessionId, rec.sessionId);
  // 2ms apart is another process on a reused pid.
  assert.equal(await presenceOf({ pid: 42, startFt: '133123456789032345', startedAt: 1 }, '/cfg', read), null);
  // A Mac process (no startFt) never takes a Windows-shaped record.
  assert.equal(await presenceOf({ pid: 42, startedAt: ftToMs(ft) }, '/cfg', read), null);
});

test('typed cd: Mac text unchanged, PowerShell quoting holds', async () => {
  const { cdThen, psQuote } = await import('../../shared/sh-quote.js');
  assert.equal(cdThen("/Users/x/Jacob's app", 'claude --resume abc', 'darwin'), "cd '/Users/x/Jacob'\\''s app' && claude --resume abc");
  assert.equal(cdThen("C:\\Code\\Jacob's app", 'claude --resume abc', 'win32'),
    "Set-Location -LiteralPath 'C:\\Code\\Jacob''s app'; if ($?) { claude --resume abc }");
  // Typographic quotes are quotes to PowerShell: doubled, so they cannot close the literal.
  assert.equal(psQuote('a\u2019; calc; \u2019b'), "'a\u2019\u2019; calc; \u2019\u2019b'");
  assert.equal(psQuote('$(calc)'), "'$(calc)'");
});

test('typed tool commands: Mac unchanged, Windows resolves an Application', async () => {
  const { toolCommand, shellArg } = await import('../../shared/sh-quote.js');
  assert.equal(toolCommand('claude', '--resume abc', 'darwin'), 'claude --resume abc');
  assert.equal(toolCommand('claude', '--resume abc', 'win32'),
    '& (Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source --resume abc');
  assert.equal(shellArg("/tmp/a'b", 'darwin'), "'/tmp/a'\\''b'");
  assert.equal(shellArg('C:\\Temp\\q\u2019; calc; #', 'win32'), "'C:\\Temp\\q\u2019\u2019; calc; #'");
  const { isPowerShell } = await import('../../shared/new-tab.js');
  assert.equal(isPowerShell('/usr/local/bin/pwsh'), false); // a Mac pwsh login shell keeps -l
});

test('cmdSafe refuses what cmd.exe would run', async () => {
  const { cmdSafe } = await import('../../shared/sh-quote.js');
  assert.equal(cmdSafe('C:\\Users\\jacob\\AppData\\Local\\Temp\\dobius-agent-1.txt'), true);
  assert.equal(cmdSafe('C:\\tmp&calc&rem\\a.txt'), false);
  assert.equal(cmdSafe('C:\\a|b'), false);
  assert.equal(cmdSafe('C:\\%PATH%\\a'), false);
  assert.equal(cmdSafe('C:\\Program Files\\x\\a.txt'), true);
});

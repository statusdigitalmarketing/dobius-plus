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
  // A plain tab runs only the gws function definition (no tool starts).
  const plain = loginShellSpawn(ps, null);
  assert.deepEqual(plain.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
  assert.doesNotMatch(Buffer.from(plain.args[3], 'base64').toString('utf16le'), /__dobius_run|claude|codex/);
  const r = loginShellSpawn(ps, 'claude');
  assert.deepEqual(r.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
  assert.deepEqual(r.env, { DOBIUS_NEW_TAB_TOOL: 'claude' });
  const script = Buffer.from(r.args[3], 'base64').toString('utf16le');
  assert.match(script, /if \(\$__dt -eq 'claude'\) \{ __dobius_run claude \}/);
  assert.doesNotMatch(script, /Invoke-Expression|iex /);
  // A tool name outside the allowlist starts a plain shell.
  assert.deepEqual(loginShellSpawn(ps, 'calc'), plain);
  // The Mac path is unchanged.
  assert.deepEqual(loginShellSpawn('/bin/zsh', null), { args: ['-l'], env: {} });
});

test('Windows console titles are not tab names', async () => {
  const { labelFromTitle } = await import('../../shared/tab-label.js');
  assert.equal(labelFromTitle('Administrator: C:\\Program Files\\PowerShell\\7\\pwsh.exe'), null);
  assert.equal(labelFromTitle('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), null);
  assert.equal(labelFromTitle('Windows PowerShell'), null);
  assert.equal(labelFromTitle('pwsh.exe'), null);
  assert.equal(labelFromTitle('Fix login bug'), 'Fix login bug');
  assert.equal(labelFromTitle('\u2733 cmd key handling'), 'cmd key handling');
  assert.equal(labelFromTitle('Administrator: C:\\temp permissions'), 'Administrator: C:\\temp permissions');
  assert.equal(labelFromTitle('powershell script cleanup'), 'powershell script cleanup');
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

test('presence matches the record Claude 2.1.319 really writes on Windows (FILETIME under procStart)', async () => {
  // Shape copied from a live C:\Users\<u>\.claude\sessions\<pid>.json on Windows 11, 2026-11-07.
  const rec = {
    pid: 3568, sessionId: '92679e5c-9b91-48d5-82f3-ae0ad806e079', cwd: 'C:\\Users\\u\\Projects\\Dobius+ Windows',
    startedAt: 1794087540530, procStart: '134385609760300755', kind: 'interactive', status: 'busy',
  };
  const read = async () => JSON.stringify(rec);
  // CIM reports the same start to the microsecond: 5 ticks (500ns) away.
  const hit = await presenceOf({ pid: 3568, startFt: '134385609760300750', startedAt: ftToMs('134385609760300750') }, null, read);
  assert.equal(hit?.sessionId, '92679e5c-9b91-48d5-82f3-ae0ad806e079');
  // path.isAbsolute reads a drive path as absolute only on Windows, where this record comes from.
  assert.equal(hit?.cwd, process.platform === 'win32' ? 'C:\\Users\\u\\Projects\\Dobius+ Windows' : null);
  // A reused pid that started 2ms later is someone else.
  assert.equal(await presenceOf({ pid: 3568, startFt: '134385609760320755', startedAt: 1 }, null, read), null);
  // A Mac process never reads a FILETIME as `ps lstart` text.
  assert.equal(await presenceOf({ pid: 3568, startedAt: ftToMs('134385609760300755') }, null, read), null);
});

test('recordStartFiletime: procStartFt first, digit-only procStart next, lstart text never', async () => {
  const { recordStartFiletime } = await import('../win-proc.js');
  assert.equal(recordStartFiletime({ procStartFt: '133123456789012345', procStart: '999' }), '133123456789012345');
  assert.equal(recordStartFiletime({ procStart: '134385609760300755' }), '134385609760300755');
  assert.equal(recordStartFiletime({ procStart: 'Tue Oct 27 12:49:51 2026' }), null);
  assert.equal(recordStartFiletime({}), null);
  assert.equal(recordStartFiletime(null), null);
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
test('Overview lists Claude Code processes on Windows, never the Claude Desktop app', async () => {
  const { claudeCodeProcessesFromWinRows } = await import('../data-service.js');
  // Command lines as CIM reports them on a Windows 11 PC with Claude Desktop (MSIX) open.
  const rows = [
    { pid: 2600, command: '"C:\\Program Files\\WindowsApps\\Claude_4.23118.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe"' },
    { pid: 21748, command: '"C:\\Program Files\\WindowsApps\\Claude_4.23118.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe" --type=renderer --lang=en-US' },
    { pid: 13716, command: '"C:\\Users\\u\\.local\\bin\\claude.exe"' },
    { pid: 10456, command: '"C:\\Users\\u\\.local\\bin\\claude.exe" --resume 317ac6ab-da03-4596-89a8-0e3eb494dd01' },
    { pid: 900, command: 'powershell.exe -NoLogo' },
  ];
  assert.deepEqual(claudeCodeProcessesFromWinRows(rows), [
    { pid: '13716', command: '"C:\\Users\\u\\.local\\bin\\claude.exe"' },
    { pid: '10456', command: '"C:\\Users\\u\\.local\\bin\\claude.exe" --resume 317ac6ab-da03-4596-89a8-0e3eb494dd01' },
  ]);
  assert.deepEqual(claudeCodeProcessesFromWinRows(null), []);
});

test('Overview kill: only a Claude running under a Dobius tab is owned, never Claude Desktop\'s own', async () => {
  const { pidsUnder, claudeProcessesFromMacRows } = await import('../data-service.js');
  const rows = [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: 500, ppid: 1, command: '/Applications/Dobius+.app/Contents/MacOS/Dobius+' },
    { pid: 600, ppid: 500, command: '/bin/zsh -l' }, // a tab's PTY
    { pid: 610, ppid: 600, command: '/Users/u/.local/bin/claude --resume abc' },
    { pid: 611, ppid: 610, command: 'node /Users/u/.claude/skills/x/mcp.js' },
    { pid: 700, ppid: 1, command: '/Applications/Claude.app/Contents/MacOS/Claude' },
    { pid: 710, ppid: 700, command: '/Users/u/Library/Application Support/Claude/claude-code/2.1.300/claude' },
    { pid: 800, ppid: 800, command: 'cycle' }, // a reused pid that is its own parent ends the walk
  ];
  const under = pidsUnder(rows, [600, 'junk', -1]);
  assert.deepEqual([...under].sort((a, b) => a - b), [600, 610, 611]);
  assert.deepEqual(claudeProcessesFromMacRows(rows).map((p) => [p.pid, under.has(Number(p.pid))]), [
    ['610', true], ['611', true], ['710', false], // Claude.app itself has no lowercase claude, as with pgrep
  ]);
  assert.deepEqual([...pidsUnder(rows, [])], []);
  assert.deepEqual([...pidsUnder(null, [600])], [600]);
});

test('Chrome profiles: Windows paths for Local State and chrome.exe, macOS unchanged', async () => {
  const { chromeLocalStatePath, chromeBinaryCandidates } = await import('../chrome-profiles.js');
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  assert.equal(chromeLocalStatePath('win32', env, 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Local State');
  assert.deepEqual(chromeBinaryCandidates('win32', env), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
  assert.deepEqual(chromeBinaryCandidates('darwin', {}), ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
});

test('Tailscale CLI is looked for in Program Files on Windows', async () => {
  const { tailscaleCandidates } = await import('../tailscale.js');
  assert.deepEqual(tailscaleCandidates('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }), [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ]);
  assert.equal(tailscaleCandidates('darwin', {})[0], '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
});

test('a missing JSONL file is quiet; an unreadable one still warns', async () => {
  const { parseJsonl } = await import('../data-utils.js');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-jsonl-'));
    assert.deepEqual(await parseJsonl(pathm.join(dir, 'history.jsonl')), []);
    assert.equal(warned.length, 0);
    assert.deepEqual(await parseJsonl(dir), []); // a directory: EISDIR, a real failure
    assert.equal(warned.length, 1);
  } finally {
    console.warn = orig;
  }
});

test('a project folder Claude encoded lossily is found from the cwd its transcript records', async () => {
  const { cwdFromTranscripts } = await import('../data-service.js');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-cwd-'));
  const real = 'C:\\Users\\u\\Projects\\Dobius+ Windows';
  const encoded = 'C--Users-u-Projects-Dobius--Windows';
  fsm.writeFileSync(pathm.join(dir, 'a.jsonl'), `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(real)},"sessionId":"x"}\n`);
  const exists = async (p) => p === real;
  assert.equal(await cwdFromTranscripts(dir, encoded, { exists }), real);
  // A cwd that encodes to a different dir name is someone else's: refused.
  assert.equal(await cwdFromTranscripts(dir, 'C--Users-u-Projects-Other', { exists }), null);
  // Gone from disk: refused.
  assert.equal(await cwdFromTranscripts(dir, encoded, { exists: async () => false }), null);
  // No transcripts: null.
  assert.equal(await cwdFromTranscripts(fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-cwd-')), encoded, { exists }), null);
});

test('History names a scheduled-task session instead of showing its XML wrapper', async () => {
  const { sanitizePreviewText } = await import('../data-service.js');
  const raw = '<scheduled-task name="review-bounce-texts-1106" file="C:\\Users\\u\\.claude\\scheduled-tasks\\review-bounce-texts-1106\\SKILL.md">\nReview the bounce texts and summarize.\n</scheduled-task>';
  assert.equal(sanitizePreviewText(raw), 'Scheduled: review-bounce-texts-1106 · Review the bounce texts and summarize.');
  assert.equal(sanitizePreviewText('Fix the <b>login</b> bug'), 'Fix the <b>login</b> bug');
});


test('Add to Claude Desktop on Windows: the Store or AppData config, and an entry that runs Dobius+.exe itself', async () => {
  const { claudeDesktopDirFor, mcpEntryFor } = await import('../gws-mcp-install.js');
  const env = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const pathm = await import('node:path');
  const msix = pathm.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  assert.equal(claudeDesktopDirFor('win32', env, 'C:\\Users\\u', (p) => p === pathm.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc')), msix);
  assert.equal(claudeDesktopDirFor('win32', env, 'C:\\Users\\u', () => false), pathm.join(env.APPDATA, 'Claude'));
  assert.deepEqual(mcpEntryFor('win32', 'C:\\D\\Dobius+.exe', 'C:\\ud\\gws-mcp\\gws-mcp.mjs', 'ignored'),
    { command: 'C:\\D\\Dobius+.exe', args: ['C:\\ud\\gws-mcp\\gws-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.deepEqual(mcpEntryFor('darwin', '/x', '/y', '/ud/gws-mcp/gws-mcp'), { command: '/ud/gws-mcp/gws-mcp' });
});

test('tab names: a Windows program path or a bare program.exe is never a label; a real topic is', async () => {
  const { labelFromTitle } = await import('../../shared/tab-label.js');
  for (const t of [
    'C:\\Users\\mrmax\\.local\\bin\\claude.exe',
    'C:\\Users\\mrmax\\.local\\bin\\claude.exe --resume 317ac6ab',
    'Administrator: C:\\WINDOWS\\system32\\cmd.exe',
    '\\\\server\\share\\tool.exe',
    'claude.exe',
    'node.exe C:\\x\\run.js',
  ]) assert.equal(labelFromTitle(t), null, t);
  assert.equal(labelFromTitle('✳ Fix the C:\\ path bug'), 'Fix the C:\\ path bug');
  assert.equal(labelFromTitle('cmd and control center'), 'cmd and control center');
});

test('Windows tab PATH: the usual tool folders that exist and are missing are appended', async () => {
  const { windowsToolDirs } = await import('../terminal-manager.js');
  const env = { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files' };
  const there = new Set(['C:\\Users\\u\\.local\\bin', 'C:\\Users\\u\\AppData\\Roaming\\npm', 'C:\\Program Files\\Tailscale']);
  const exists = (p) => there.has(p);
  assert.deepEqual(windowsToolDirs('C:\\Windows\\system32;C:\\Users\\u\\AppData\\Roaming\\npm\\', env, exists),
    ['C:\\Users\\u\\.local\\bin', 'C:\\Program Files\\Tailscale'], 'npm already there (trailing slash, any case); nodejs and Git absent');
  assert.deepEqual(windowsToolDirs('c:\\users\\u\\.local\\bin;c:\\program files\\tailscale;C:\\Users\\u\\AppData\\Roaming\\npm', env, exists), []);
});

test('gws shim on Windows: gws.cmd runs the shim under Electron; real gws is npm run.js, never the shim folder', async () => {
  const { windowsShimWrapper, resolveRealGwsWindows } = await import('../gws-accounts.js');
  assert.equal(
    windowsShimWrapper('C:\\Apps\\Dobius+.exe', 'C:\\U\\gws-shim\\gws-shim.mjs', 'C:\\U\\gws-shim\\gws.cmd'),
    '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset ELECTRON_RUN_AS_NODE=1\r\nset "DOBIUS_GWS_SHIM_SELF=C:\\U\\gws-shim\\gws.cmd"\r\n"C:\\Apps\\Dobius+.exe" "C:\\U\\gws-shim\\gws-shim.mjs" %*\r\n',
  );
  // A path cmd would read as syntax gets no wrapper at all.
  assert.equal(windowsShimWrapper('C:\\100%\\Dobius+.exe', 'C:\\U\\s.mjs', 'C:\\U\\gws.cmd'), null);
  assert.equal(windowsShimWrapper('C:\\Apps\\Dobius+.exe', 'C:\\U\\a"b.mjs', 'C:\\U\\gws.cmd'), null);
  assert.equal(windowsShimWrapper('C:\\Apps\\Dobius+.exe', 'C:\\U\\s.mjs', 'C:\\U\\x\r\ncalc'), null);
  assert.equal(windowsShimWrapper('C:\\Apps\\Dobius+.exe', 'C:\\Users\\José\\gws-shim.mjs', 'C:\\U\\gws.cmd'), null);
  // Such a folder still gets a gws.cmd: one that refuses, so cmd.exe never falls through to npm's gws as the default account.
  const { WINDOWS_REFUSING_CMD } = await import('../gws-accounts.js');
  assert.match(WINDOWS_REFUSING_CMD, /^@echo off\r\n1>&2 echo gws: .*\r\nexit \/b 1\r\n$/);
  assert.ok(!/[%!"()^&|<>]/.test(WINDOWS_REFUSING_CMD.split('echo gws:')[1].split('\r\n')[0]), 'nothing cmd.exe would interpret');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const appdata = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-gwsnpm-'));
  try {
    const pkg = pathm.join(appdata, 'npm', 'node_modules', '@googleworkspace', 'cli');
    fsm.mkdirSync(pkg, { recursive: true });
    fsm.writeFileSync(pathm.join(pkg, 'package.json'), JSON.stringify({ bin: { gws: 'run.js' } }));
    fsm.writeFileSync(pathm.join(pkg, 'run.js'), '');
    assert.equal(resolveRealGwsWindows(null, { APPDATA: appdata, Path: '' }), pathm.join(pkg, 'run.js'));
    // The shim folder itself is never the real gws.
    assert.equal(resolveRealGwsWindows(pkg, { APPDATA: appdata, Path: '' }), null);
    assert.equal(resolveRealGwsWindows(null, { APPDATA: pathm.join(appdata, 'none'), Path: '' }), null);
  } finally {
    fsm.rmSync(appdata, { recursive: true, force: true });
  }
});

test('Settings on Windows: no macOS-only sections; the menu and the page agree', async () => {
  const { SETTINGS_SECTIONS, settingsSectionsFor } = await import('../../src/lib/settings-sections.js');
  assert.deepEqual(settingsSectionsFor('darwin'), SETTINGS_SECTIONS);
  assert.deepEqual(settingsSectionsFor('win32').map((s) => s.id),
    ['gws', 'appearance', 'terminal', 'projects', 'integrations', 'today', 'mobile', 'team', 'shortcuts', 'diagnostics']);
});

test('Settings > Keyboard Shortcuts on Windows lists only keys that do something', async () => {
  const { WINDOWS_SHORTCUT_ROWS } = await import('../../shared/win-keys.js');
  const press = (combo) => {
    const parts = combo.split('+');
    const key = parts.pop();
    return { type: 'keydown', key: key === 'Tab' ? 'Tab' : key.toLowerCase(), ctrlKey: parts.includes('Ctrl'), shiftKey: parts.includes('Shift'), altKey: false, metaKey: false };
  };
  const chords = WINDOWS_SHORTCUT_ROWS.map((r) => r.keys).filter((k) => k.startsWith('Ctrl+'));
  assert.ok(chords.length >= 15, 'the Ctrl chords are listed');
  for (const k of chords) {
    const combo = k === 'Ctrl+1-9' ? 'Ctrl+5' : k;
    const e = press(combo);
    const app = winToMacShortcut(e) || winTerminalKey(e, true);
    assert.ok(app, `${k} does nothing on Windows`);
  }
  assert.equal(WINDOWS_SHORTCUT_ROWS.some((r) => /Cmd/.test(r.keys)), false);
});

test('Terminal fonts offered on Windows are Windows fonts, Mac list unchanged', async () => {
  const { curatedTerminalFontsFor, CURATED_TERMINAL_FONTS } = await import('../../src/lib/terminal-font.js');
  assert.equal(curatedTerminalFontsFor('darwin'), CURATED_TERMINAL_FONTS);
  const win = curatedTerminalFontsFor('win32');
  assert.deepEqual(win.map((f) => f.id), ['', 'Cascadia Mono', 'Consolas', 'Lucida Console', 'Courier New']);
  assert.equal(win[0].label, 'Default (Cascadia Code)');
});

test('the Voice Conductor (macOS voice) is not listed on Windows', async () => {
  const { visibleBuiltinAgents } = await import('../visible-agents.js');
  const agents = [{ id: 'builtin-code-reviewer' }, { id: 'builtin-voice-conductor' }, { id: 'builtin-test-writer' }];
  assert.deepEqual(visibleBuiltinAgents(agents, 'win32').map((a) => a.id), ['builtin-code-reviewer', 'builtin-test-writer']);
  assert.equal(visibleBuiltinAgents(agents, 'darwin'), agents);
  assert.deepEqual(visibleBuiltinAgents(null, 'win32'), []);
});

test('gws shim on Windows: ! is refused in gws.cmd; Git Bash gets an sh wrapper; npm with its own prefix is found', async () => {
  const { windowsShimWrapper, windowsShShimWrapper, resolveRealGwsWindows } = await import('../gws-accounts.js');
  assert.equal(windowsShimWrapper('C:\\Apps\\!CHANNEL!\\Dobius+.exe', 'C:\\U\\s.mjs', 'C:\\U\\gws.cmd'), null);
  assert.equal(
    windowsShShimWrapper('C:\\Users\\José\\Dobius+.exe', 'C:\\U\\gws-shim\\gws-shim.mjs', 'C:\\U\\gws-shim\\gws'),
    "#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport DOBIUS_GWS_SHIM_SELF='C:/U/gws-shim/gws'\nexec 'C:/Users/José/Dobius+.exe' 'C:/U/gws-shim/gws-shim.mjs' \"$@\"\n",
  );
  // $ " ` and ' stay literal (single quotes; a ' is closed, escaped, reopened); only a control character is refused.
  assert.match(windowsShShimWrapper('C:\\a$b`c"d\\Dobius+.exe', 'C:\\U\\s.mjs', 'C:\\U\\gws'), /exec 'C:\/a\$b`c"d\/Dobius\+\.exe'/);
  assert.match(windowsShShimWrapper("C:\\O'Neil\\Dobius+.exe", 'C:\\U\\s.mjs', 'C:\\U\\gws'), /exec 'C:\/O'\\''Neil\/Dobius\+\.exe'/);
  assert.equal(windowsShShimWrapper('C:\\a\nb\\Dobius+.exe', 'C:\\U\\s.mjs', 'C:\\U\\gws'), null);
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const prefix = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-npmprefix-'));
  try {
    const pkg = pathm.join(prefix, 'node_modules', '@googleworkspace', 'cli');
    fsm.mkdirSync(pkg, { recursive: true });
    fsm.writeFileSync(pathm.join(pkg, 'package.json'), JSON.stringify({ bin: { gws: 'run.js' } }));
    fsm.writeFileSync(pathm.join(pkg, 'run.js'), '');
    if (process.platform === 'win32') {
      assert.equal(resolveRealGwsWindows(null, { APPDATA: pathm.join(prefix, 'none'), Path: prefix }), pathm.join(pkg, 'run.js'));
    }
    const { npmGwsEntry } = await import('../gws-setup.js');
    assert.equal(npmGwsEntry(prefix), pathm.join(pkg, 'run.js'));
    assert.equal(npmGwsEntry(pathm.join(prefix, 'nothing')), null);
  } finally {
    fsm.rmSync(prefix, { recursive: true, force: true });
  }
});

test('PowerShell tabs define gws as the shim run straight under Electron (JSON quotes survive)', async () => {
  const { loginShellSpawn, newTabCommand } = await import('../../shared/new-tab.js');
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  // A plain tab and one that starts Claude both get it.
  for (const spawn of [loginShellSpawn(pwsh, null), loginShellSpawn(pwsh, newTabCommand('claude'))]) {
    const enc = spawn.args[spawn.args.indexOf('-EncodedCommand') + 1];
    assert.ok(spawn.args.includes('-NoExit'));
    const script = Buffer.from(enc, 'base64').toString('utf16le');
    assert.match(script, /function global:gws \{/);
    assert.match(script, /\[System\.Diagnostics\.Process\]::Start\(\$i\)/);
    assert.match(script, /\$global:LASTEXITCODE = \$p\.ExitCode/);
    assert.match(script, /\$i\.EnvironmentVariables\['ELECTRON_RUN_AS_NODE'\] = '1'/);
    assert.doesNotMatch(script, /\$env:ELECTRON_RUN_AS_NODE =/); // never set for the whole session
    // The whole tree ends (the shim's real gws is its child), then the shim itself as a fallback.
  assert.match(script, /finally \{ if \(\$p -and -not \$p\.HasExited\) \{ try \{ & "\$env:SystemRoot\\System32\\taskkill\.exe" \/PID \$p\.Id \/T \/F 2>\$null \| Out-Null \} catch \{ \}; try \{ \$p\.Kill\(\) \}/);
  }
  // zsh/bash tabs are untouched.
  assert.deepEqual(loginShellSpawn('/bin/zsh', null).args, ['-l']);
});

// Runs only on Windows (CI): the real PowerShell, 5.1 and 7 when present, calling the gws function with a stand-in
// "shim" (a node script that prints its arguments and exits 3) in place of Dobius's Electron.
test('PowerShell gws function: arguments arrive intact, it waits, the exit code and output come back', { skip: process.platform !== 'win32' }, async () => {
  const { PS_GWS_FUNCTION } = await import('../../shared/new-tab.js');
  const fsm = await import('node:fs');
  const os = await import('node:os');
  const pathm = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-psgws-'));
  let other = null;
  try {
    const stand = pathm.join(dir, 'shim.js');
    fsm.writeFileSync(stand, "let inp = ''; process.stdin.on('data', (d) => { inp += d; }); process.stdin.on('end', () => setTimeout(() => { process.stdout.write(JSON.stringify({ args: process.argv.slice(2), run: process.env.ELECTRON_RUN_AS_NODE, cwd: process.cwd(), inp }) + '\\n'); process.exit(3); }, 300));");
    other = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'dobius-pscwd-'));
    const tricky = ['gmail', 'users', 'getProfile', '--params', '{"userId":"me"}', 'two words', 'C:\\end\\', '', 'a"b c'];
    const lit = (a) => `'${a.replace(/'/g, "''")}'`;
    // A profile alias named gws must not shadow the function; an array argument passes its elements separately.
    const body = `Set-Alias -Name gws -Value whoami.exe -Scope Global; ${PS_GWS_FUNCTION}; Set-Location -LiteralPath ${lit(other)}; $r = gws ${tricky.map(lit).join(' ')}; "EXIT=$LASTEXITCODE"; "OUT=$r"; "AFTER=$env:ELECTRON_RUN_AS_NODE"; $piped = 'hello', 'café' | gws x; "PIPED=$piped"; $arr = 'drive', 'files list'; $ar = gws $arr 'z'; "ARR=$ar"; $au = gws auth login; "AUTHCAP=[$au]"; $al = 'auth', 'setup'; $as = gws $al; "SETUPCAP=[$as]"; $st = gws auth status; "STATUS=$st"`;
    const env = { ...process.env, DOBIUS_GWS_SHIM_JS: stand, DOBIUS_ELECTRON_EXE: process.execPath };
    delete env.ELECTRON_RUN_AS_NODE;
    const shells = ['powershell.exe', 'pwsh.exe'].filter((sh) => spawnSync(sh, ['-NoProfile', '-Command', 'exit 0']).status === 0);
    assert.ok(shells.length > 0);
    for (const sh of shells) {
      const r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-Command', body], { env, encoding: 'utf8' });
      const out = r.stdout.replace(/\r/g, '');
      assert.match(out, /EXIT=3/, `${sh}: ${out} ${r.stderr}`);
      const json = JSON.parse(out.split('\n').find((l) => l.startsWith('OUT=')).slice(4));
      assert.deepEqual(json.args, tricky, sh);
      assert.equal(json.run, '1', sh);
      assert.equal(fsm.realpathSync.native(json.cwd).toLowerCase(), fsm.realpathSync.native(other).toLowerCase(), `${sh}: runs in the tab's current folder`);
      const piped = JSON.parse(out.split('\n').find((l) => l.startsWith('PIPED=')).slice(6));
      assert.deepEqual(piped.inp.replace(/\r/g, '').split('\n').filter(Boolean), ['hello', 'café'], `${sh}: piped input reaches gws as UTF-8`);
      const arr = JSON.parse(out.split('\n').find((l) => l.startsWith('ARR=')).slice(4));
      assert.deepEqual(arr.args, ['drive', 'files list', 'z'], `${sh}: array elements are separate arguments`);
      // gws auth login / setup draw on the console: nothing captured, the output went straight to the screen (here,
      // stdout), the array form included. Every other auth command is captured like any command.
      assert.match(out, /^AUTHCAP=\[\]$/m, `${sh}: auth login output is not captured`);
      assert.match(out, /^SETUPCAP=\[\]$/m, `${sh}: auth setup (array form) output is not captured`);
      const direct = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).args);
      assert.deepEqual(direct, [['auth', 'login'], ['auth', 'setup']], `${sh}: only login and setup reach the console directly`);
      assert.deepEqual(JSON.parse(out.split('\n').find((l) => l.startsWith('STATUS=')).slice(7)).args, ['auth', 'status'], `${sh}: auth status is captured`);
      assert.match(out, /AFTER=\n|AFTER=$/m, `${sh}: ELECTRON_RUN_AS_NODE must not stay set`);
    }
  } finally {
    fsm.rmSync(dir, { recursive: true, force: true });
    if (other) fsm.rmSync(other, { recursive: true, force: true });
  }
});

test('Windows keeps one Dobius per userData; the lock module loads right after the userData override', async () => {
  const { takesSingleInstanceLock } = await import('../single-instance.js');
  assert.equal(takesSingleInstanceLock('win32'), true);
  assert.equal(takesSingleInstanceLock('darwin'), false);
  assert.equal(takesSingleInstanceLock('linux'), false);
  const fsm = await import('node:fs');
  const src = fsm.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const imports = src.split('\n').filter((l) => /^import /.test(l)).slice(0, 2);
  assert.deepEqual(imports.map((l) => (l.match(/from '(.+?)'|import '(.+?)'/) || []).slice(1).find(Boolean)), ['./dev-userdata.js', './single-instance.js']);
  // Opened again while closing: relaunch once this copy is gone, with the arg that makes the new copy wait for the lock.
  const { RELAUNCH_ARG } = await import('../single-instance.js');
  assert.equal(RELAUNCH_ARG, '--dobius-relaunch');
  assert.match(src, /app\.relaunch\(\{ args: \[\.\.\.process\.argv\.slice\(1\)\.filter\(\(a\) => a !== RELAUNCH_ARG\), RELAUNCH_ARG\] \}\)/);
  // \r?\n: a Windows checkout has CRLF line endings.
  assert.match(src, /app\.on\('second-instance', \(_e, argv\) => \{\r?\n.*\r?\n.*\r?\n    if \(Array\.isArray\(argv\) && \(argv\.includes\(RELAUNCH_ARG\) \|\| argv\.includes\('--updated'\)\)\) return;/);
});

test('the lock: a normal second launch hands over at once; a launch after an update waits for the old copy', async () => {
  const { acquireLock } = await import('../single-instance.js');
  const asks = (answers) => { let i = 0; const f = () => answers[Math.min(i++, answers.length - 1)]; f.count = () => i; return f; };
  const held = asks([false]);
  assert.equal(acquireLock(held), false);
  assert.equal(held.count(), 1, 'no retry without --updated');
  const freed = asks([false, false, false, true]);
  let slept = 0;
  assert.equal(acquireLock(freed, { updated: true, sleep: (ms) => { slept += ms; } }), true);
  assert.equal(slept, 750);
  const never = asks([false]);
  assert.equal(acquireLock(never, { updated: true, sleep: () => {}, waitMs: 1000, stepMs: 250 }), false);
  assert.equal(never.count(), 5, 'gives up after the wait');
});

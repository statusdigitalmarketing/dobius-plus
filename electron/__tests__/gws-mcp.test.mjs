// gws-mcp argv building + flag-smuggling guards (v1.0.63). The MCP server
// hands model-controlled strings to execFile, so the positional allowlist is
// a security boundary: a tool call must never be able to inject gws flags
// like --upload or --output.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildArgv, findGws, gwsInvocation, claudeDesktopDirFor, mergeClaudeConfig, quotaHint, noQuotaEnv } from '../gws-mcp.mjs';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

// Happy path: positional parts + params + body in gws's own flag shapes.
check('gmail list builds the documented argv',
  buildArgv({ command: ['gmail', 'users', 'messages', 'list'], params: { userId: 'me', maxResults: 5 } }).argv,
  ['gmail', 'users', 'messages', 'list', '--params', '{"userId":"me","maxResults":5}']);
check('body rides --json',
  buildArgv({ command: ['gmail', 'users', 'messages', 'send'], body: { raw: 'x' } }).argv,
  ['gmail', 'users', 'messages', 'send', '--json', '{"raw":"x"}']);
check('unlisted API via service:version positional',
  buildArgv({ command: ['people:v1', 'people', 'get'] }).argv,
  ['people:v1', 'people', 'get']);
check('apiVersion + format + pageAll append their flags',
  buildArgv({ command: ['drive', 'files', 'list'], apiVersion: 'v2', format: 'table', pageAll: true }).argv,
  ['drive', 'files', 'list', '--api-version', 'v2', '--format', 'table', '--page-all']);

// The security boundary: no flag smuggling through positionals.
check('a leading-dash positional is rejected',
  buildArgv({ command: ['drive', '--upload'] }).error !== undefined, true);
check('a path-looking positional is rejected',
  buildArgv({ command: ['drive', 'files', '/etc/passwd'] }).error !== undefined, true);
check('whitespace in a positional is rejected',
  buildArgv({ command: ['drive', 'files list'] }).error !== undefined, true);
check('too few parts rejected', buildArgv({ command: ['drive'] }).error !== undefined, true);
check('too many parts rejected',
  buildArgv({ command: ['a', 'b', 'c', 'd', 'e', 'f'] }).error !== undefined, true);
check('non-array command rejected', buildArgv({ command: 'drive files list' }).error !== undefined, true);

// params/body must be objects; arrays and strings would change gws semantics.
check('string params rejected', buildArgv({ command: ['a', 'b'], params: 'x' }).error !== undefined, true);
check('array body rejected', buildArgv({ command: ['a', 'b'], body: [1] }).error !== undefined, true);
check('bad format rejected', buildArgv({ command: ['a', 'b'], format: 'xml' }).error !== undefined, true);
check('apiVersion with a dash-prefix rejected', buildArgv({ command: ['a', 'b'], apiVersion: '--x' }).error !== undefined, true);

// findGws returns an absolute homebrew/usr-local path or the bare name; it
// must never resolve into a Dobius shim dir (those live under userData).
const gwsPath = findGws();
check('findGws avoids Dobius shim dirs', gwsPath.includes('dobius') || gwsPath.includes('Application Support'), false);

// --- Windows support (v1.0.64): invocation resolution + config paths. gws on
// Windows is a .cmd shim Node cannot execFile, so the CLI's JS entry must run
// under our own node; the config dir comes from APPDATA. ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwsmcp-win-'));
  const fakeCliDir = path.join(tmp, 'npm', 'node_modules', '@googleworkspace', 'cli', 'bin');
  fs.mkdirSync(fakeCliDir, { recursive: true });
  fs.writeFileSync(path.join(fakeCliDir, 'gws'), '// fake cli entry');

  const inv2 = gwsInvocation('win32', { APPDATA: tmp });
  check('win32 resolves the CLI js under APPDATA npm prefix and runs it under our node',
    inv2.argsPrefix?.[0] === path.join(tmp, 'npm', 'node_modules', '@googleworkspace', 'cli', 'bin', 'gws')
      && inv2.file === process.execPath, true);
  check('win32 with no CLI installed reports an actionable error',
    typeof gwsInvocation('win32', { APPDATA: path.join(tmp, 'nope') }).error, 'string');
  check('GWS_MCP_GWS_JS override wins',
    gwsInvocation('win32', { GWS_MCP_GWS_JS: path.join(fakeCliDir, 'gws') }).argsPrefix?.[0],
    path.join(fakeCliDir, 'gws'));
  // Current releases publish bin as run.js at the package ROOT (Codex High):
  // the package's own bin map must win over any literal guess.
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gwsmcp-win2-'));
  const pkgDir2 = path.join(tmp2, 'npm', 'node_modules', '@googleworkspace', 'cli');
  fs.mkdirSync(pkgDir2, { recursive: true });
  fs.writeFileSync(path.join(pkgDir2, 'package.json'), JSON.stringify({ bin: { gws: 'run.js' } }));
  fs.writeFileSync(path.join(pkgDir2, 'run.js'), '// entry');
  check('win32 resolves the entry from the package bin map (run.js layout)',
    gwsInvocation('win32', { APPDATA: tmp2 }).argsPrefix?.[0], path.join(pkgDir2, 'run.js'));
  fs.rmSync(tmp2, { recursive: true, force: true });
  check('posix path untouched by win32 logic', gwsInvocation('darwin', {}).argsPrefix, []);

  check('claude dir on win32 comes from APPDATA',
    claudeDesktopDirFor('win32', { APPDATA: 'C:\\Users\\b\\AppData\\Roaming' }, '/h'),
    path.join('C:\\Users\\b\\AppData\\Roaming', 'Claude'));
  check('claude dir on win32 without APPDATA is null (setup must refuse)',
    claudeDesktopDirFor('win32', {}, '/h'), null);
  check('claude dir on darwin is the Library path',
    claudeDesktopDirFor('darwin', {}, '/Users/b'),
    '/Users/b/Library/Application Support/Claude');
  check('GWS_MCP_CLAUDE_DIR override wins on any platform',
    claudeDesktopDirFor('win32', { GWS_MCP_CLAUDE_DIR: '/tmp/x' }, '/h'), '/tmp/x');

  check('config merge preserves other servers',
    mergeClaudeConfig('{"mcpServers":{"a":{"command":"/x"}}}', { command: 'node', args: ['/s'] }).next.mcpServers.a,
    { command: '/x' });
  check('config merge refuses malformed', typeof mergeClaudeConfig('{oops', {}).error, 'string');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The gws hint file (Justin, 2026-11-07): an npm gws Dobius found is used; the shim itself never is.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-mcp-hint-'));
  const real = path.join(tmp, 'npm-global', 'bin', 'gws');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
  check('findGws uses the hinted gws', findGws({ gws: real }), real);
  const shim = path.join(tmp, 'gws-shim', 'gws');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '#!/bin/sh\n', { mode: 0o755 });
  check('findGws never picks the Dobius shim', findGws({ gws: shim }) === shim, false);
  fs.rmSync(tmp, { recursive: true, force: true });
  const nq = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-mcp-nq-'));
  const e = noQuotaEnv({ GOOGLE_WORKSPACE_PROJECT_ID: 'forbidden', KEEP: '1' }, path.join(nq, '.noquota'));
  check('no-quota env clears all three project sources', [e.GOOGLE_WORKSPACE_PROJECT_ID, e.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, fs.existsSync(e.GOOGLE_APPLICATION_CREDENTIALS), e.KEEP], ['', path.join(nq, '.noquota'), false, '1']);
  // A link planted at the credentials name is removed, never written through (Codex round 5).
  fs.mkdirSync(path.join(nq, '.noquota'), { recursive: true });
  fs.writeFileSync(path.join(nq, 'victim.json'), 'KEEP');
  fs.symlinkSync(path.join(nq, 'victim.json'), path.join(nq, '.noquota', 'no-adc.json'));
  noQuotaEnv({}, path.join(nq, '.noquota'));
  // .noquota itself a link (to the real gws config, say): nothing inside is deleted, the call refuses (round 6).
  const realCfg = path.join(nq, 'real-cfg');
  fs.mkdirSync(realCfg);
  fs.writeFileSync(path.join(realCfg, 'client_secret.json'), 'REAL CLIENT');
  fs.symlinkSync(realCfg, path.join(nq, 'linked-noquota'));
  check('a linked .noquota is refused', noQuotaEnv({}, path.join(nq, 'linked-noquota')), null);
  check('and the real client file survives', fs.readFileSync(path.join(realCfg, 'client_secret.json'), 'utf8'), 'REAL CLIENT');
  // A file in .noquota that cannot be removed: refuse rather than let it carry a project (round 7).
  const locked = path.join(nq, 'locked-noquota');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'client_secret.json'), '{"installed":{"project_id":"x"}}');
  fs.chmodSync(locked, 0o555);
  check('an undeletable client file in .noquota is refused', noQuotaEnv({}, locked), null);
  fs.chmodSync(locked, 0o755);
  check('a planted link is removed and its target untouched', [fs.existsSync(path.join(nq, '.noquota', 'no-adc.json')), fs.readFileSync(path.join(nq, 'victim.json'), 'utf8')], [false, 'KEEP']);
  fs.rmSync(nq, { recursive: true, force: true });
  const denied = '{"error":{"code":403,"message":"Grant the caller the roles/serviceusage.serviceUsageConsumer role"}}';
  check('a quota refusal gets the plain explanation', /Its sign-in is fine/.test(quotaHint(denied)), true);
  check('a call that named no account is told to name one', /named no account/.test(quotaHint(denied, { named: false })), true);
  check('other output is left alone', quotaHint('{"ok":1}'), '{"ok":1}');
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

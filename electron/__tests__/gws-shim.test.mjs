// gws token-broker shim routing (v1.0.41). Covers the HTTP-free paths:
// transparent passthrough (no account) and requested-but-unconnected (error,
// no gws run). The mint path needs live Google HTTP and is proven when Sam
// connects and runs the shim in a real terminal.
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-shim.mjs');

let pass = 0, fail = 0;
const check = (label, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-shim-home-'));
const fakeGws = path.join(home, 'fake-gws.sh');
await fs.writeFile(fakeGws, '#!/bin/sh\necho "REAL args=[$*] token=${GOOGLE_WORKSPACE_CLI_TOKEN:-none}"\nexit 7\n', { mode: 0o755 });
await fs.chmod(fakeGws, 0o755);

const run = (env, args) => spawnSync(process.execPath, [SHIM, ...args], {
  env: { ...process.env, HOME: home, DOBIUS_REAL_GWS: fakeGws, ...env },
  encoding: 'utf8',
});

// 1. Passthrough: no account requested -> runs the real gws, no token, and
//    propagates the real gws exit code (7).
{
  const r = run({}, ['gmail', 'list']);
  check('passthrough runs real gws with args', r.stdout.includes('args=[gmail list]'));
  check('passthrough injects NO token', r.stdout.includes('token=none'));
  check('passthrough propagates real gws exit code', r.status === 7);
}

// 2. Account requested but none connected -> error, real gws NOT run, exit 1.
{
  const r = run({ DOBIUS_GWS_ACCOUNT: 'nobody@example.com' }, ['gmail', 'list']);
  check('unconnected account errors', /no connected/i.test(r.stderr));
  check('unconnected account does NOT run real gws', !r.stdout.includes('REAL'));
  check('unconnected account exits non-zero', r.status === 1);
}

// 3. Account requested by id but profile missing -> error, no gws run.
{
  const r = run({ DOBIUS_GWS_ACCOUNT_ID: 'gws-doesnotexist000000' }, ['x']);
  check('unknown id errors', /no connected/i.test(r.stderr));
  check('unknown id does NOT run real gws', !r.stdout.includes('REAL'));
}

// 4. ID is AUTHORITATIVE (Codex holistic P2): a real profile exists for an
//    email, but a bound ID that does NOT exist is set alongside it. The shim
//    must NOT fall back to the matching email; it must error on the id.
{
  const profDir = path.join(home, '.gws-profiles');
  await fs.mkdir(profDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(profDir, 'gws-realprofileaaaaaaaa.json'),
    JSON.stringify({ email: 'exists@example.com', client_id: 'c', client_secret: 's', refresh_token: 'r' }),
    { mode: 0o600 },
  );
  const r = run(
    { DOBIUS_GWS_ACCOUNT_ID: 'gws-boundbutmissing0000', DOBIUS_GWS_ACCOUNT: 'exists@example.com' },
    ['gmail'],
  );
  check('bound id wins over a matching email (errors on the id, no email fallback)', /no connected/i.test(r.stderr));
  check('authoritative-id case does NOT run real gws as the email account', !r.stdout.includes('REAL'));
  await fs.rm(profDir, { recursive: true, force: true });
}

// 5. Quota project (Justin, 2026-11-07): an account marked noQuotaProject runs gws with the empty
//    ~/.gws-profiles/.noquota config folder; an unmarked one keeps the normal config. A cached token keeps it offline.
{
  const profDir = path.join(home, '.gws-profiles');
  await fs.mkdir(profDir, { recursive: true, mode: 0o700 });
  const cfgGws = path.join(home, 'cfg-gws.sh');
  await fs.writeFile(cfgGws, '#!/bin/sh\necho "CFG=${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-default} token=${GOOGLE_WORKSPACE_CLI_TOKEN:-none} PID=[${GOOGLE_WORKSPACE_PROJECT_ID-unset}] ADC=${GOOGLE_APPLICATION_CREDENTIALS:-none}"\n', { mode: 0o755 });
  const exp = Date.now() + 3600_000;
  for (const [id, email, mark] of [['gws-personalaaaaaaaaaaa', 'me@gmail.com', true], ['gws-workspaceaaaaaaaaaa', 'me@acme.com', false]]) {
    await fs.writeFile(path.join(profDir, `${id}.json`), JSON.stringify({ email, client_id: 'c', client_secret: 's', refresh_token: 'r', ...(mark ? { noQuotaProject: true } : {}) }), { mode: 0o600 });
    await fs.writeFile(path.join(profDir, `.token-${id}.json`), JSON.stringify({ token: `tok-${id}`, expiresAt: exp }), { mode: 0o600 });
  }
  const p1 = run({ DOBIUS_GWS_ACCOUNT_ID: 'gws-personalaaaaaaaaaaa', DOBIUS_REAL_GWS: cfgGws }, ['drive']);
  check('a marked account runs with the empty .noquota config folder', p1.stdout.includes(`CFG=${path.join(profDir, '.noquota')}`) && p1.stdout.includes('token=tok-gws-personal'), p1.stdout + p1.stderr);
  check('and an empty project variable and a gcloud credentials path with nothing at it', p1.stdout.includes('PID=[]') && p1.stdout.includes(`ADC=${path.join(profDir, '.noquota', 'no-adc.json')}`), p1.stdout);
  const p1b = run({ DOBIUS_GWS_ACCOUNT_ID: 'gws-personalaaaaaaaaaaa', DOBIUS_REAL_GWS: cfgGws, GOOGLE_WORKSPACE_PROJECT_ID: 'forbidden-proj' }, ['drive']);
  check('an inherited GOOGLE_WORKSPACE_PROJECT_ID is cleared for a marked account', p1b.stdout.includes('PID=[]'), p1b.stdout);
  await fs.mkdir(path.join(profDir, '.noquota'), { recursive: true });
  await fs.writeFile(path.join(profDir, '.noquota', 'client_secret.json'), '{"installed":{"project_id":"x"}}');
  run({ DOBIUS_GWS_ACCOUNT_ID: 'gws-personalaaaaaaaaaaa', DOBIUS_REAL_GWS: cfgGws }, ['drive']);
  check('a client file that appeared in .noquota is removed', await fs.access(path.join(profDir, '.noquota', 'client_secret.json')).then(() => false, () => true));
  const p2 = run({ DOBIUS_GWS_ACCOUNT_ID: 'gws-workspaceaaaaaaaaaa', DOBIUS_REAL_GWS: cfgGws }, ['drive']);
  check('an unmarked account keeps the normal gws config', p2.stdout.includes('CFG=default') && p2.stdout.includes('PID=[unset]'), p2.stdout + p2.stderr);
  // No account named: gws runs as its own login, untouched, even when a marked profile exists (Codex round 3: running
  // it as a stored account could act as the wrong one after a gws auth login, or override a token passed in).
  const b1 = run({ DOBIUS_REAL_GWS: cfgGws }, ['drive', 'files', 'list']);
  check('a bare call is a plain passthrough', b1.stdout.includes('token=none') && b1.stdout.includes('CFG=default'), b1.stdout + b1.stderr);
  await fs.rm(profDir, { recursive: true, force: true });
}

await fs.rm(home, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

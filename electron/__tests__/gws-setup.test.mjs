// gws setup on a fresh Mac (Justin, 2026-11-07): finding gws where npm put it, the OAuth client file, and the hint the
// shim reads. Everything runs against throwaway folders; nothing touches the real ~/.config/gws.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { candidateDirs, findIn, readClientFile, findClientFiles, useClientFile, useGwsAt, isInside, needsNodeFor, joinPath, setHintDir, effectiveQuotaProject, npmPrefix, halfInstalled } from '../gws-setup.js';

let pass = 0, fail = 0;
const check = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-gws-setup-'));
const home = path.join(root, 'home');
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const exe = (p, body = '#!/bin/sh\necho ok\n') => { mk(path.dirname(p)); fs.writeFileSync(p, body, { mode: 0o755 }); fs.chmodSync(p, 0o755); return p; };

// 1. Candidate folders: npm's prefix, ~/.npm-global, the NEWEST nvm node, then the fixed ones; no duplicates.
{
  for (const v of ['v18.20.1', 'v22.3.0', 'v9.11.2', 'v22.10.0']) mk(path.join(home, '.nvm', 'versions', 'node', v, 'bin'));
  const dirs = candidateDirs({ home, shellDirs: ['/usr/local/bin', '/x/shell'], npmPrefix: '/x/prefix' });
  check('shell PATH comes before the guesses', dirs.indexOf('/x/shell') < dirs.indexOf(path.join(home, '.npm-global', 'bin')));
  check("npm's global bin is included", dirs.includes('/x/prefix/bin'));
  check('~/.npm-global/bin is included', dirs.includes(path.join(home, '.npm-global', 'bin')));
  check('the newest nvm version is picked (v22.10.0, not v9 or v22.3)', dirs.includes(path.join(home, '.nvm', 'versions', 'node', 'v22.10.0', 'bin')) && !dirs.some((d) => d.includes('v9.11.2')));
  check('no duplicates', new Set(dirs).size === dirs.length);
  check('relative entries are dropped', candidateDirs({ home, shellDirs: ['bin', '.', ''] }).every((d) => d.startsWith('/')));
}

// 2. findIn: first executable, skipping the shim's own folder and non-executables.
{
  const a = mk(path.join(root, 'a'));
  const shim = mk(path.join(root, 'shim'));
  const b = mk(path.join(root, 'b'));
  fs.writeFileSync(path.join(a, 'gws'), 'not executable', { mode: 0o644 });
  exe(path.join(shim, 'gws'));
  exe(path.join(b, 'gws'));
  check('skips a non-executable and the shim folder', findIn([a, shim, b], 'gws', shim) === path.join(b, 'gws'));
  check('null when nothing is there', findIn([a], 'gws') === null);
}

// 3. The OAuth client file: only a real installed/web client, never the secret in the summary.
const desktop = JSON.stringify({ installed: { client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret', project_id: 'acme-gws', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', redirect_uris: ['http://localhost'] } });
{
  const good = path.join(root, 'good.json'); fs.writeFileSync(good, desktop);
  const web = path.join(root, 'web.json'); fs.writeFileSync(web, JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }));
  const bad = path.join(root, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ installed: { client_id: 'x' } }));
  const junk = path.join(root, 'junk.json'); fs.writeFileSync(junk, 'not json');
  const info = readClientFile(good);
  check('a desktop client is read with its project', info?.project === 'acme-gws' && info.kind === 'desktop');
  check('the summary never carries the secret', !JSON.stringify(info).includes('GOCSPX'));
  check('a web client counts', readClientFile(web)?.kind === 'web');
  check('a client with no secret is refused', readClientFile(bad) === null);
  check('a non-JSON file is refused', readClientFile(junk) === null);
  check('a missing file is refused', readClientFile(path.join(root, 'none.json')) === null);
}

// 4. Found on this Mac: other ~/.config/gws* folders and ~/Downloads/client_secret*.json.
{
  mk(path.join(home, '.config', 'gws-old'));
  fs.writeFileSync(path.join(home, '.config', 'gws-old', 'client_secret.json'), desktop);
  mk(path.join(home, 'Downloads'));
  fs.writeFileSync(path.join(home, 'Downloads', 'client_secret_123-abc.apps.googleusercontent.com.json'), desktop);
  fs.writeFileSync(path.join(home, 'Downloads', 'client_secret_broken.json'), '{}');
  fs.writeFileSync(path.join(home, 'Downloads', 'other.json'), desktop);
  const found = findClientFiles({ home }).map((c) => c.path).sort();
  check('finds the old gws config and the Downloads file, nothing else', found.length === 2
    && found.some((p) => p.endsWith(path.join('gws-old', 'client_secret.json')))
    && found.some((p) => p.includes('Downloads') && p.includes('client_secret_123')));
}

// 5. Using a client file: folder 700, file 600, a symlinked target is refused, an invalid file changes nothing.
{
  const target = path.join(home, '.config', 'gws', 'client_secret.json');
  const src = path.join(root, 'good.json');
  const r = useClientFile(src, { target });
  check('copied in', r.ok === true && fs.readFileSync(target, 'utf8') === desktop);
  check('file is mode 600', (fs.statSync(target).mode & 0o777) === 0o600);
  check('folder is mode 700', (fs.statSync(path.dirname(target)).mode & 0o777) === 0o700);
  const bad = useClientFile(path.join(root, 'bad.json'), { target });
  check('an invalid file is refused and the old one kept', bad.ok === false && fs.readFileSync(target, 'utf8') === desktop);
  const linkTarget = path.join(root, 'linked', 'client_secret.json');
  mk(path.dirname(linkTarget));
  const elsewhere = path.join(root, 'elsewhere.json'); fs.writeFileSync(elsewhere, 'keep');
  fs.symlinkSync(elsewhere, linkTarget);
  const viaLink = useClientFile(src, { target: linkTarget });
  check('a symlinked target is refused and what it points at is untouched', viaLink.ok === false && fs.readFileSync(elsewhere, 'utf8') === 'keep');
}

// 6. Locate gws: only a file named gws (or run.js), and it must be executable.
{
  const notGws = exe(path.join(root, 'tools', 'evil'));
  const noExec = path.join(root, 'tools2', 'gws'); mk(path.dirname(noExec)); fs.writeFileSync(noExec, 'x', { mode: 0o644 });
  check('a file not named gws is refused', (await useGwsAt(notGws)).ok === false);
  check('a non-executable gws is refused', (await useGwsAt(noExec)).ok === false);
  check('a relative path is refused', (await useGwsAt('gws')).ok === false);
}

// 7. The shim reads gws-env.json beside itself when DOBIUS_REAL_GWS is unset or stale, and adds its PATH at the end.
{
  const SHIM_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-shim.mjs');
  const shimDir = mk(path.join(root, 'gws-shim'));
  const shimJs = path.join(shimDir, 'gws-shim.mjs');
  fs.copyFileSync(SHIM_SRC, shimJs);
  const real = exe(path.join(root, 'npm-global', 'bin', 'gws'), '#!/bin/sh\necho "HINTED args=[$*] path=$PATH"\nexit 3\n');
  fs.writeFileSync(path.join(shimDir, 'gws-env.json'), JSON.stringify({ gws: real, path: '/hint/dir' }));
  const run = (env) => spawnSync(process.execPath, [shimJs, 'drive', 'list'], {
    env: { HOME: home, PATH: '/usr/bin:/bin', DOBIUS_GWS_SHIM_SELF: path.join(shimDir, 'gws'), ...env }, encoding: 'utf8',
  });
  const r = run({});
  check('no DOBIUS_REAL_GWS: the hinted gws runs', r.stdout.includes('HINTED args=[drive list]') && r.status === 3);
  check("the hint's PATH comes first for the gws process", r.stdout.includes('path=/hint/dir:/usr/bin:/bin'));
  const stale = run({ DOBIUS_REAL_GWS: path.join(root, 'gone', 'gws') });
  check('a stale DOBIUS_REAL_GWS falls through to the hint', stale.stdout.includes('HINTED'));
  fs.writeFileSync(path.join(shimDir, 'gws-env.json'), JSON.stringify({ gws: path.join(shimDir, 'gws'), path: '' }));
  exe(path.join(shimDir, 'gws'));
  const self = run({});
  check('a hint pointing at the shim itself is ignored', self.status === 127 && /not installed/.test(self.stderr));
}

// 8. Codex round 1: a gws link pointing at the shim is the shim; node only for a node script; no empty PATH entries.
{
  const shimDir = mk(path.join(root, 'r1-shim'));
  exe(path.join(shimDir, 'gws'));
  const aliasDir = mk(path.join(root, 'r1-local-bin'));
  fs.symlinkSync(path.join(shimDir, 'gws'), path.join(aliasDir, 'gws'));
  const realDir = mk(path.join(root, 'r1-brew'));
  exe(path.join(realDir, 'gws'));
  check('a link to the shim is skipped, the real gws found', findIn([aliasDir, realDir], 'gws', shimDir) === path.join(realDir, 'gws'));
  check('isInside follows links', isInside(path.join(aliasDir, 'gws'), shimDir) && !isInside(path.join(realDir, 'gws'), shimDir));
  const nodeScript = exe(path.join(root, 'r1-npm', 'gws'), '#!/usr/bin/env node\nconsole.log(1)\n');
  const native = path.join(root, 'r1-native', 'gws'); mk(path.dirname(native)); fs.writeFileSync(native, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]), { mode: 0o755 });
  check('the npm run.js needs node', needsNodeFor(nodeScript) === true);
  check('a native gws does not', needsNodeFor(native) === false);
  check('joinPath drops empty and relative entries', joinPath('/a:/b', '', ':.:bin:/c') === '/a:/b:/c');
  check('joinPath with no PATH at all has no leading colon', joinPath('/a', undefined) === '/a');
  // Locate refuses the shim (even through a link), and a pick survives a restart through gws-env.json.
  setHintDir(shimDir);
  check('Locate refuses a link to the shim', (await useGwsAt(path.join(aliasDir, 'gws'))).ok === false);
  fs.writeFileSync(path.join(shimDir, 'gws-env.json'), JSON.stringify({ located: path.join(realDir, 'gws') }));
}
{
  // A fresh module instance stands in for a restart.
  const fresh = await import(`../gws-setup.js?restart=${Date.now()}`);
  fresh.setHintDir(path.join(root, 'r1-shim'));
  const st = await fresh.refreshGwsEnv();
  check('a gws picked with Locate comes back after a restart', st.gws === path.join(root, 'r1-brew', 'gws'), st.gws);
  const hint = JSON.parse(fs.readFileSync(path.join(root, 'r1-shim', 'gws-env.json'), 'utf8'));
  check('and stays in the hint', hint.located === path.join(root, 'r1-brew', 'gws'));
  check('no temp files left behind', fs.readdirSync(path.join(root, 'r1-shim')).every((f) => !f.includes('.tmp-')));
}
// 9. Codex round 2.
{
  // Web application clients: readable, but never offered or copied (gws signs in with a desktop client).
  const web = path.join(home, 'Downloads', 'client_secret_web.json');
  fs.writeFileSync(web, JSON.stringify({ web: { client_id: 'w', client_secret: 's', project_id: 'p' } }));
  check('a web client is not offered as found', !findClientFiles({ home }).some((c) => c.path === web));
  const r = useClientFile(web, { target: path.join(root, 'webtarget', 'client_secret.json') });
  check('a web client is refused with the reason', r.ok === false && /Desktop app client/.test(r.error));
  // A symlinked client file is read through the link.
  const linked = path.join(root, 'linked-client.json');
  fs.symlinkSync(path.join(root, 'good.json'), linked);
  check('a linked client file counts', readClientFile(linked)?.kind === 'desktop');
  // The project gws would send, in gws's order.
  check('the env variable wins', effectiveQuotaProject({ GOOGLE_WORKSPACE_PROJECT_ID: 'from-env' }) === 'from-env');
  const adc = path.join(root, 'adc.json');
  fs.writeFileSync(adc, JSON.stringify({ quota_project_id: 'from-adc' }));
  // A fresh process whose gws config folder has no client file: the gcloud project is what gws would send.
  const emptyCfg = mk(path.join(root, 'empty-cfg'));
  const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-setup.js');
  const probe = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { effectiveQuotaProject } from ${JSON.stringify(SETUP)}; console.log(String(effectiveQuotaProject()));`], { env: { PATH: process.env.PATH, HOME: home, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: emptyCfg, ...env }, encoding: 'utf8' }).stdout.trim();
  check('gcloud default credentials are the last resort', probe({ GOOGLE_APPLICATION_CREDENTIALS: adc }) === 'from-adc');
  fs.writeFileSync(path.join(emptyCfg, 'client_secret.json'), desktop);
  check('the client file beats gcloud', probe({ GOOGLE_APPLICATION_CREDENTIALS: adc }) === 'acme-gws');
  check('nothing anywhere: null', probe({ GOOGLE_APPLICATION_CREDENTIALS: path.join(root, 'none.json'), GOOGLE_WORKSPACE_CLI_CONFIG_DIR: mk(path.join(root, 'empty-cfg2')) }) === 'null');
}

// 10. Codex round 3: gws's older config folder is used while ~/.config/gws does not exist, so Dobius writes there and
//     never creates ~/.config/gws next to it (that would make gws drop its saved login).
{
  const h = mk(path.join(root, 'legacy-home'));
  mk(path.join(h, 'Library', 'Application Support', 'gws'));
  const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-setup.js');
  const dirOf = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { gwsConfigDir } from ${JSON.stringify(SETUP)}; console.log(gwsConfigDir());`], { env: { PATH: process.env.PATH, HOME: h }, encoding: 'utf8' }).stdout.trim();
  check('legacy folder used when ~/.config/gws is absent', dirOf() === path.join(h, 'Library', 'Application Support', 'gws'));
  mk(path.join(h, '.config', 'gws'));
  check('~/.config/gws wins once it exists', dirOf() === path.join(h, '.config', 'gws'));
}

// 11. Codex round 4: another Dobius copy's shim is never gws; incomplete client files are reported, not used.
{
  const other = mk(path.join(root, 'other-dobius', 'gws-shim'));
  exe(path.join(other, 'gws'), '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport DOBIUS_GWS_SHIM_SELF="/x/gws"\nexec /x "$@"\n');
  const realDir = mk(path.join(root, 'r4-brew'));
  exe(path.join(realDir, 'gws'));
  check("another Dobius copy's shim is skipped", findIn([other, realDir], 'gws') === path.join(realDir, 'gws'));
  const inc = path.join(root, 'incomplete.json');
  fs.writeFileSync(inc, JSON.stringify({ installed: { client_id: 'a', client_secret: 'b', project_id: 'p' } }));
  check('a client without auth_uri/token_uri is incomplete', readClientFile(inc)?.kind === 'incomplete');
  const r = useClientFile(inc, { target: path.join(root, 'inc-target', 'client_secret.json') });
  check('and is refused with what to do', r.ok === false && /download it again/i.test(r.error));
}

// 12. Codex round 5.
{
  // npm's prefix is read, never run for: env first, then ~/.npmrc (with ~ and $HOME expanded).
  const nh = mk(path.join(root, 'npmrc-home'));
  check('NPM_CONFIG_PREFIX wins', npmPrefix({ env: { NPM_CONFIG_PREFIX: '/opt/np' }, home: nh }) === '/opt/np');
  fs.writeFileSync(path.join(nh, '.npmrc'), 'registry=https://r\nprefix=~/.npm-global\n');
  check('~/.npmrc prefix with ~', npmPrefix({ env: {}, home: nh }) === path.join(nh, '.npm-global'));
  fs.writeFileSync(path.join(nh, '.npmrc'), 'prefix=${HOME}/tools\n');
  check('~/.npmrc prefix with ${HOME}', npmPrefix({ env: {}, home: nh }) === path.join(nh, 'tools'));
  fs.writeFileSync(path.join(nh, '.npmrc'), 'prefix=relative/dir\n');
  check('a relative prefix is ignored', npmPrefix({ env: {}, home: nh }) === null);
  // Half installed: run.js linked, binary never downloaded.
  const pkg = mk(path.join(root, 'pkg', '@googleworkspace', 'cli'));
  const runjs = exe(path.join(pkg, 'run.js'), '#!/usr/bin/env node\n');
  const linkDir = mk(path.join(root, 'pkg-bin'));
  fs.symlinkSync(runjs, path.join(linkDir, 'gws'));
  check('run.js without its binary is half installed', halfInstalled(path.join(linkDir, 'gws')) === true);
  exe(path.join(pkg, 'bin', 'gws'));
  check('with the binary it is not', halfInstalled(path.join(linkDir, 'gws')) === false);
  // Locate refuses another Dobius copy's shim.
  const other = mk(path.join(root, 'r5-other', 'gws-shim'));
  exe(path.join(other, 'gws'), '#!/bin/sh\nexport DOBIUS_GWS_SHIM_SELF="/x"\n');
  check("Locate refuses another Dobius copy's shim", (await useGwsAt(path.join(other, 'gws'))).ok === false);
  // gws 0.22.5's loader: redirect_uris and auth_provider_x509_cert_url may be absent (round 6), not null; project_id
  // is required.
  const variant = (mutate) => { const j = JSON.parse(desktop); mutate(j.installed); const f = path.join(root, `v-${Math.abs(JSON.stringify(j).length)}-${Object.keys(j.installed).length}.json`); fs.writeFileSync(f, JSON.stringify(j)); return readClientFile(f)?.kind; };
  check('no redirect_uris: still usable', variant((c) => { delete c.redirect_uris; }) === 'desktop');
  check('no x509 url: still usable', variant((c) => { delete c.auth_provider_x509_cert_url; }) === 'desktop');
  check('redirect_uris null: incomplete', variant((c) => { c.redirect_uris = null; }) === 'incomplete');
  check('no project_id: incomplete', variant((c) => { delete c.project_id; }) === 'incomplete');
  fs.writeFileSync(path.join(nh, '.npmrc'), 'prefix=/Users/alice/cli-tools # global tools\n');
  check('~/.npmrc inline comment is dropped', npmPrefix({ env: {}, home: nh }) === '/Users/alice/cli-tools');
}

// 13. Codex round 7.
{
  const nh2 = mk(path.join(root, 'npmrc-home2'));
  fs.writeFileSync(path.join(nh2, '.npmrc'), 'prefix="/Users/alice/Tools #1"\n');
  check('a quoted prefix keeps its #', npmPrefix({ env: {}, home: nh2 }) === '/Users/alice/Tools #1');
  fs.writeFileSync(path.join(nh2, '.npmrc'), "prefix='/Users/alice/t' ; note\n");
  check('a quoted prefix with a comment after it', npmPrefix({ env: {}, home: nh2 }) === '/Users/alice/t');
  check('redirect_uris with a non-string: incomplete', (() => { const j = JSON.parse(desktop); j.installed.redirect_uris = [null]; const f = path.join(root, 'r7-null-uri.json'); fs.writeFileSync(f, JSON.stringify(j)); return readClientFile(f)?.kind; })() === 'incomplete');
}
{
  // A complete gws later on PATH beats a half-installed launcher earlier; a Locate pick adds no folder to PATH.
  const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-setup.js');
  const halfPkg = mk(path.join(root, 'r7-half', 'lib', 'cli'));
  exe(path.join(halfPkg, 'run.js'), '#!/usr/bin/env node\n');
  const halfBin = mk(path.join(root, 'r7-half', 'bin'));
  fs.symlinkSync(path.join(halfPkg, 'run.js'), path.join(halfBin, 'gws'));
  const good = mk(path.join(root, 'r7-good'));
  exe(path.join(good, 'gws'), '#!/bin/sh\n');
  const run = (code, env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, HOME: home, DOBIUS_USERDATA_DIR: path.join(root, 'ud'), ...env }, encoding: 'utf8' }).stdout.trim();
  const picked = run(`import { refreshGwsEnv } from ${JSON.stringify(SETUP)}; console.log((await refreshGwsEnv()).gws);`, { DOBIUS_GWS_SETUP_DIRS: `${halfBin}:${good}` });
  check('a complete gws beats an earlier half-installed one', picked === path.join(good, 'gws'), picked);
  const dl = mk(path.join(root, 'r7-downloads'));
  exe(path.join(dl, 'gws'), '#!/bin/sh\n');
  exe(path.join(dl, 'node'), '#!/bin/sh\necho planted\n');
  const pathStr = run(`import { useGwsAt, gwsState } from ${JSON.stringify(SETUP)}; await useGwsAt(${JSON.stringify(path.join(dl, 'gws'))}); console.log(gwsState().gws + '|' + gwsState().pathString);`, { DOBIUS_GWS_SETUP_DIRS: good });
  check('a Locate pick is used but its folder is not on PATH', pathStr.startsWith(`${path.join(dl, 'gws')}|`) && !pathStr.split('|')[1].split(':').includes(dl), pathStr);
}

// 14. Codex round 8.
{
  const nh3 = mk(path.join(root, 'npmrc-home3'));
  fs.writeFileSync(path.join(nh3, '.npmrc'), 'prefix=/Users/alice/old-tools\nprefix=/Users/alice/new-tools\n');
  check('the last prefix= wins', npmPrefix({ env: {}, home: nh3 }) === '/Users/alice/new-tools');
  fs.writeFileSync(path.join(nh3, '.npmrc'), 'prefix=/Users/alice/Tools \\#1\n');
  check('an escaped # is decoded', npmPrefix({ env: {}, home: nh3 }) === '/Users/alice/Tools #1');
  const j = JSON.parse(desktop); j.installed.client_id = '';
  const f = path.join(root, 'r8-empty-id.json'); fs.writeFileSync(f, JSON.stringify(j));
  check('an empty client_id is not a client', readClientFile(f) === null);
}
{
  // A native gws later on PATH beats an npm launcher that has no node to run it.
  const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-setup.js');
  const npmPkg = mk(path.join(root, 'r8-npm', 'lib', 'cli'));
  exe(path.join(npmPkg, 'run.js'), '#!/usr/bin/env node\n');
  exe(path.join(npmPkg, 'bin', 'gws'), '#!/bin/sh\n');
  const npmBin = mk(path.join(root, 'r8-npm', 'bin'));
  fs.symlinkSync(path.join(npmPkg, 'run.js'), path.join(npmBin, 'gws'));
  const brew = mk(path.join(root, 'r8-brew'));
  fs.writeFileSync(path.join(brew, 'gws'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]), { mode: 0o755 });
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `import { refreshGwsEnv } from ${JSON.stringify(SETUP)}; console.log((await refreshGwsEnv()).gws);`], { env: { PATH: '/usr/bin:/bin', HOME: home, DOBIUS_USERDATA_DIR: path.join(root, 'ud'), DOBIUS_GWS_SETUP_DIRS: `${npmBin}:${brew}` }, encoding: 'utf8' }).stdout.trim();
  check('a native gws beats an npm launcher with no node', out === path.join(brew, 'gws'), out);
}

// 15. Codex round 9.
{
  const nh4 = mk(path.join(root, 'npmrc-home4'));
  fs.writeFileSync(path.join(nh4, '.npmrc'), 'prefix=/Users/alice/tools#global\n');
  check('a # with no space is a comment too', npmPrefix({ env: {}, home: nh4 }) === '/Users/alice/tools');
  // The quota project follows gws's loader (empty strings are fine there), not Setup's stricter check.
  const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gws-setup.js');
  const cfg = mk(path.join(root, 'r9-cfg'));
  const j = JSON.parse(desktop); j.installed.client_secret = '';
  fs.writeFileSync(path.join(cfg, 'client_secret.json'), JSON.stringify(j));
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `import { effectiveQuotaProject } from ${JSON.stringify(SETUP)}; console.log(String(effectiveQuotaProject()));`], { env: { PATH: process.env.PATH, HOME: home, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: cfg, GOOGLE_APPLICATION_CREDENTIALS: path.join(root, 'none.json') }, encoding: 'utf8' }).stdout.trim();
  check('an empty client_secret still sends its project, as gws does', out === 'acme-gws', out);
}

// 16. Codex round 10.
{
  const nh5 = mk(path.join(root, 'npmrc-home5'));
  fs.writeFileSync(path.join(nh5, '.npmrc'), 'prefix=/Users/alice/tools\\\\#note\n');
  check('an escaped backslash before # leaves the # a comment', npmPrefix({ env: {}, home: nh5 }) === '/Users/alice/tools\\');
  fs.writeFileSync(path.join(nh5, '.npmrc'), 'prefix=/Users/alice/tools\\archive\n');
  check('any other backslash stays literal', npmPrefix({ env: {}, home: nh5 }) === '/Users/alice/tools\\archive');
  fs.writeFileSync(path.join(nh5, '.npmrc'), 'prefix=${XDG_DATA_HOME}/npm\n');
  check('${VAR} is expanded from the environment', npmPrefix({ env: { XDG_DATA_HOME: '/Users/alice/.local/share' }, home: nh5 }) === '/Users/alice/.local/share/npm');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

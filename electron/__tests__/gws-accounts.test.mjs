// gws multi-account storage + security layer (v1.0.41). The token MINT needs
// live Google HTTP and is proven when Sam clicks Connect in the app; this
// covers everything else: the registry CRUD, id validation, path derivation
// (Codex plan #3 path-traversal), and email resolution.
//
// Isolate HOME so config (userData via the electron stub) and ~/.gws-profiles
// both land in throwaway dirs, same trick as the other suites.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-gws-home-'));
process.env.HOME = TMP_HOME;
process.env.DOBIUS_TEST_USERDATA = path.join(TMP_HOME, 'userdata');

const cfg = await import('../config-manager.js');
const gws = await import('../gws-accounts.js');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

// --- id validation ---
check('valid id accepted', cfg.isValidGwsId('gws-abcDEF012345_-xyz'), true);
check('empty rejected', cfg.isValidGwsId(''), false);
check('too short rejected', cfg.isValidGwsId('gws-abc'), false);
check('wrong prefix rejected', cfg.isValidGwsId('acct-abcdef0123456789'), false);

// --- path derivation / traversal (Codex plan #3) ---
const goodId = 'gws-abcdefghijklmnop01';
const p = gws.profilePathFor(goodId);
check('good id derives a path inside ~/.gws-profiles',
  p && p.startsWith(path.join(TMP_HOME, '.gws-profiles')) && p.endsWith(`${goodId}.json`), true);
for (const bad of ['gws-../../etc/passwd', 'gws-a/b', 'gws-a.b', '../x', 'gws-', 'gws-short', '']) {
  check(`traversal/bad id rejected: ${JSON.stringify(bad)}`, gws.profilePathFor(bad), null);
}

// --- registry CRUD (metadata only, never secrets) ---
check('registry starts empty', gws.listGwsAccounts(), []);
cfg.saveGwsAccount({ id: goodId, email: 'sam@example.com', name: 'sam@example.com', scopes: ['a', 'b'], addedAt: 1 });
const listed = gws.listGwsAccounts();
check('one account listed with metadata', listed.length === 1 && listed[0].email === 'sam@example.com' && listed[0].scopes.length === 2, true);
check('saveGwsAccount rejects a bad id', cfg.saveGwsAccount({ id: 'nope', email: 'x@y.com' }), null);
check('saveGwsAccount rejects missing email', cfg.saveGwsAccount({ id: 'gws-anothergoodid12345' }), null);

// --- email resolution ---
check('idForEmail resolves (case-insensitive)', gws.idForEmail('SAM@example.com'), goodId);
check('idForEmail unknown -> null', gws.idForEmail('nobody@example.com'), null);

// --- remove deletes the profile file + registry entry ---
await fs.mkdir(path.join(TMP_HOME, '.gws-profiles'), { recursive: true });
await fs.writeFile(p, JSON.stringify({ email: 'sam@example.com', refresh_token: 'x' }), { mode: 0o600 });
let existed = true;
try { await fs.stat(p); } catch { existed = false; }
check('profile file exists before remove', existed, true);
await gws.removeGwsAccount(goodId);
let gone = false;
try { await fs.stat(p); } catch { gone = true; }
check('profile file deleted after remove', gone, true);
check('registry empty after remove', gws.listGwsAccounts(), []);

// --- no-follow write (Codex r2 P2): a symlink at the profile path must NOT be
// followed; the pointed-at file must stay untouched. ---
{
  const profDir = path.join(TMP_HOME, '.gws-profiles');
  await fs.mkdir(profDir, { recursive: true, mode: 0o700 });
  const victim = path.join(TMP_HOME, 'victim.txt');
  await fs.writeFile(victim, 'DO NOT OVERWRITE');
  const symId = 'gws-symlinkattack01234';
  const symPath = gws.profilePathFor(symId);
  await fs.symlink(victim, symPath); // attacker points the profile at victim
  let threw = false;
  try {
    await gws.writeProfile(symId, { email: 'x@y.com', refresh_token: 'secret-should-not-land' });
  } catch {
    threw = true;
  }
  check('writeProfile refuses to follow a symlink', threw, true);
  const victimContent = await fs.readFile(victim, 'utf8');
  check('the symlink target is left untouched (no token written to it)', victimContent, 'DO NOT OVERWRITE');
}

// --- mustExist (Codex round 2): a quota-mark update must never recreate a profile that was removed meanwhile. ---
{
  const goneId = 'gws-removedmeanwhile01';
  let err = null;
  try { await gws.writeProfile(goneId, { email: 'x@y.com', refresh_token: 'r', noQuotaProject: true }, { mustExist: true }); } catch (e) { err = e.message; }
  check('mustExist write to a removed profile fails', err, 'profile_gone');
  check('and does not recreate it', await fs.access(gws.profilePathFor(goneId)).then(() => true, () => false), false);
  await gws.writeProfile(goneId, { email: 'x@y.com', refresh_token: 'r' });
  await gws.writeProfile(goneId, { email: 'x@y.com', refresh_token: 'r', noQuotaProject: true }, { mustExist: true });
  check('mustExist updates one that is there', JSON.parse(await fs.readFile(gws.profilePathFor(goneId), 'utf8')).noQuotaProject, true);
  await fs.rm(gws.profilePathFor(goneId), { force: true });
}

// --- no-follow DIRECTORY (Codex r3 P2): if ~/.gws-profiles is itself a
// symlink, writing a token must refuse rather than land it in the target. ---
{
  const home2 = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-gws-symdir-'));
  const realElsewhere = path.join(home2, 'elsewhere');
  await fs.mkdir(realElsewhere, { recursive: true });
  // Re-point HOME so PROFILES_DIR resolves under home2, and make ~/.gws-profiles a symlink.
  process.env.HOME = home2;
  await fs.symlink(realElsewhere, path.join(home2, '.gws-profiles'));
  // Re-import with the new HOME (module caches PROFILES_DIR at load).
  const gws2 = await import(`../gws-accounts.js?symdir=${Date.now()}`);
  let threw = false;
  try {
    await gws2.writeProfile('gws-symdirattack012345', { email: 'x@y.com', refresh_token: 'nope' });
  } catch {
    threw = true;
  }
  check('writeProfile refuses a symlinked profiles dir', threw, true);
  const leaked = await fs.readdir(realElsewhere);
  check('nothing written into the symlink target dir', leaked, []);
  process.env.HOME = TMP_HOME; // restore for cleanup
  await fs.rm(home2, { recursive: true, force: true });
}

// --- removal must NOT claim success if the token file can't be deleted
// (Codex r5 P2): keep the account so the orphaned token can be retried. ---
{
  const rid = 'gws-removalfailcase0123';
  cfg.saveGwsAccount({ id: rid, email: 'keep@example.com', name: 'keep', scopes: [], addedAt: 1 });
  const rp = gws.profilePathFor(rid);
  const rdir = path.dirname(rp);
  await fs.mkdir(rdir, { recursive: true, mode: 0o700 });
  await fs.writeFile(rp, JSON.stringify({ email: 'keep@example.com', refresh_token: 'live' }), { mode: 0o600 });
  await fs.chmod(rdir, 0o500); // remove write on the dir so unlink fails (EACCES/EPERM)
  const res = await gws.removeGwsAccount(rid);
  await fs.chmod(rdir, 0o700); // restore so cleanup + assertions can proceed
  check('removeGwsAccount reports failure when the token file cannot be deleted', res.ok, false);
  const stillListed = gws.listGwsAccounts().some((a) => a.id === rid);
  check('the account stays in the registry after a failed delete', stillListed, true);
  let fileStillThere = false;
  try { await fs.stat(rp); fileStillThere = true; } catch { /* */ }
  check('the token file is still on disk (not silently lost)', fileStillThere, true);
  // now a real removal should succeed
  const res2 = await gws.removeGwsAccount(rid);
  check('retry removal succeeds once the dir is writable', res2.ok, true);
}

// --- clearShimTokenCache (Codex holistic P2): reconnect/remove must drop the
// shim's on-disk token cache so a stale bearer token is not reused. ---
{
  const cid = 'gws-cacheclearcase01234';
  const profDir = path.join(TMP_HOME, '.gws-profiles');
  await fs.mkdir(profDir, { recursive: true, mode: 0o700 });
  const cacheFile = path.join(profDir, `.token-${cid}.json`);
  await fs.writeFile(cacheFile, JSON.stringify({ token: 'stale', expiresAt: Date.now() + 3600000 }), { mode: 0o600 });
  let before = false; try { await fs.stat(cacheFile); before = true; } catch { /* */ }
  check('shim token cache exists before clear', before, true);
  await gws.clearShimTokenCache(cid);
  let after = true; try { await fs.stat(cacheFile); } catch { after = false; }
  check('clearShimTokenCache deletes the stale token cache', after, false);
  check('clearShimTokenCache on a bad id is a no-op (no throw)', await gws.clearShimTokenCache('nope') ?? true, true);
}

// --- extractGoogleAuthUrl: reconnect must open the URL gws prints (no TTY
// means gws never opens the browser itself; v1.0.61 discarded the output and
// the button hung on "Waiting for browser..."). ---
{
  const real = 'Open this URL in your browser to authenticate:\n\n  https://accounts.google.com/o/oauth2/auth?scope=x%20y&redirect_uri=http://localhost:59383&response_type=code&client_id=abc.apps.googleusercontent.com&prompt=select_account+consent\n\n';
  check('real gws stderr yields the full URL',
    gws.extractGoogleAuthUrl(real),
    'https://accounts.google.com/o/oauth2/auth?scope=x%20y&redirect_uri=http://localhost:59383&response_type=code&client_id=abc.apps.googleusercontent.com&prompt=select_account+consent');
  check('URL split across chunks: first half alone is not a match',
    gws.extractGoogleAuthUrl('Open this URL in your browser:\n\n  https://accounts.goog'), null);
  check('a URL that runs to the end of the buffer waits for its terminator (chunk boundary, Codex High)',
    gws.extractGoogleAuthUrl('  https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=http://localhost:593'), null);
  check('the same URL followed by a newline is complete',
    gws.extractGoogleAuthUrl('  https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=http://localhost:59383\n'),
    'https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=http://localhost:59383');
  check('non-Google origins are never eligible for openExternal',
    gws.extractGoogleAuthUrl('visit https://evil.example.com/accounts.google.com/phish now'), null);
  check('a Google-looking hostname prefix on another domain is rejected',
    gws.extractGoogleAuthUrl('https://accounts.google.com.evil.example/o/oauth2/auth'), null);
  check('plain text yields null', gws.extractGoogleAuthUrl('no url here'), null);
  check('non-string input is safe', gws.extractGoogleAuthUrl(undefined), null);
}

// --- scope modes (v1.0.64, Sam: "options like full or w/o gcp so the auth
// never dies"): standard must carry every productivity scope and NEITHER
// Google Cloud scope, or Workspace grants die with invalid_rapt in ~16h. ---
{
  const std = gws.loginArgsFor('standard');
  check('standard uses --scopes', std.slice(0, 3), ['auth', 'login', '--scopes']);
  const scopes = std[3].split(',');
  check('standard has NO cloud-platform', scopes.some((x) => x.includes('cloud-platform')), false);
  check('standard has NO pubsub', scopes.some((x) => x.includes('pubsub')), false);
  for (const need of ['gmail.modify', 'drive', 'calendar', 'documents', 'presentations', 'spreadsheets', 'tasks', 'userinfo.email']) {
    check(`standard keeps ${need}`, scopes.some((x) => x.includes(need)), true);
  }
  check('full is gws --full', gws.loginArgsFor('full'), ['auth', 'login', '--full']);
  check('unknown mode falls back to standard (never silently full)',
    gws.loginArgsFor('bogus')[2], '--scopes');
}

// quotaProjectDenied (Justin, 2026-11-07): Google's refusal to let an account use the client's Cloud project.
{
  const resp = (status, body) => ({ ok: status < 300, status, text: async () => body });
  const seen = [];
  const fake = (answers) => async (url, init) => { seen.push({ url, project: init.headers['x-goog-user-project'] }); return answers.shift(); };
  const denied = 'Caller does not have required permission to use project gmail-oauth-1. Grant the caller the roles/serviceusage.serviceUsageConsumer role';
  check('no project: nothing to refuse, no request', await gws.quotaProjectDenied('t', null, fake([])), false);
  check('Drive 200 with the project: allowed', await gws.quotaProjectDenied('t', 'p1', fake([resp(200, '{}')])), false);
  seen.length = 0;
  check('Drive 403 serviceusage: refused', await gws.quotaProjectDenied('t', 'p1', fake([resp(403, denied)])), true);
  check('the probe sends the project as x-goog-user-project', seen[0]?.project, 'p1');
  check('Drive not granted, Gmail refuses: refused', await gws.quotaProjectDenied('t', 'p1', fake([resp(403, 'Request had insufficient authentication scopes'), resp(403, denied)])), true);
  check('Drive 503 then Gmail OK: unknown, a Gmail OK alone clears nothing', await gws.quotaProjectDenied('t', 'p1', fake([resp(503, 'unavailable'), resp(200, '{}')])), null);
  check('neither API can tell: unknown (null), never a guess', await gws.quotaProjectDenied('t', 'p1', fake([resp(403, 'insufficient scopes'), resp(500, 'oops')])), null);
  check('network failure: unknown', await gws.quotaProjectDenied('t', 'p1', async () => { throw new Error('offline'); }), null);
}

await fs.rm(TMP_HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);

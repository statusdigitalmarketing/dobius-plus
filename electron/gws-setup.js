// Getting gws working on a fresh Mac (Justin, 2026-11-07, Dobius 2.2.6 on an Intel Mac: "real gws not found", no
// install prompt, no OAuth client, unclear that accounts are added in Dobius).
//
// - Where gws and node are: a Finder-launched app does not get the login shell's PATH, and `npm i -g` lands in a user
//   prefix (~/.npm-global/bin), nvm, volta or fnm. So the PATH is read from the login shell, then the usual install
//   folders and npm's prefix (read from ~/.npmrc, never by running npm) are added. The npm gws is a node script
//   (`#!/usr/bin/env node`), so a checked node goes first on the PATH everything that runs gws uses (gwsExecEnv()).
// - What was found is written to <userData>/gws-shim/gws-env.json, which the terminal shim (gws-shim.mjs) and the Claude
//   Desktop server (gws-mcp.mjs) read, so a gws installed later works without restarting Dobius. A gws picked with
//   Locate is kept there too, so it survives a restart.
// - Setup actions for Settings > Google Accounts: install gws with npm, locate it by hand, and find or choose the OAuth
//   client file (~/.config/gws/client_secret.json), copied in with mode 600.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';

// Ship-test only, and only in an isolated instance (DOBIUS_USERDATA_DIR): stand in for a fresh Mac with a throwaway
// home (no client file) and a fixed list of folders (no Homebrew gws), so the Setup flow can be driven end to end.
const HARNESS = !!process.env.DOBIUS_USERDATA_DIR;
const FAKE_DIRS = HARNESS && process.env.DOBIUS_GWS_SETUP_DIRS ? process.env.DOBIUS_GWS_SETUP_DIRS.split(':').filter((d) => d.startsWith('/')) : null;
const HOME = (HARNESS && process.env.DOBIUS_GWS_SETUP_HOME) || os.homedir();
// gws's config folder, chosen the way gws 0.22.5 chooses it: GOOGLE_WORKSPACE_CLI_CONFIG_DIR when set, else
// ~/.config/gws, except that an older install keeps using ~/Library/Application Support/gws while ~/.config/gws does
// not exist. Read each time: creating ~/.config/gws next to a legacy setup would make gws drop its saved login.
// gws's older location is dirs::config_dir(): ~/Library/Application Support on a Mac, %APPDATA% on Windows.
const LEGACY_DIR = process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'gws')
  : path.join(HOME, 'Library', 'Application Support', 'gws');
export function gwsConfigDir(env = process.env) {
  // gws takes the override whenever it is SET, relative (even empty: the current folder) as is.
  if (env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR !== undefined) return path.resolve(env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR);
  const primary = path.join(HOME, '.config', 'gws');
  return !fs.existsSync(primary) && fs.existsSync(LEGACY_DIR) ? LEGACY_DIR : primary;
}
export const gwsClientSecretPath = (env = process.env) => path.join(gwsConfigDir(env), 'client_secret.json');
export const GWS_PACKAGE = '@googleworkspace/cli';
const STATIC_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const MARK = '__DOBIUS_PATH__';
const WIN = process.platform === 'win32';

let shellPathCache = null; // string[] | null
const START_DIRS = FAKE_DIRS || STATIC_DIRS;
let state = { dirs: [...START_DIRS], gws: null, node: null, npm: null, needsNode: true, pathString: START_DIRS.join(':') };
let userGws = null; // set by "Locate gws…", kept in gws-env.json as `located`
let hintDir = null; // <userData>/gws-shim, where gws-env.json goes
let looked = false; // a look has run this launch, so `state` is real

const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/** Is `p` (through any links) inside `dir` (through any links)? A gws link pointing at the shim must count. */
export function isInside(p, dir) {
  if (!p || !dir) return false;
  const rp = real(p);
  const rd = real(dir);
  return !!rp && !!rd && (rp === rd || rp.startsWith(rd + path.sep));
}

/** Does this gws need node (the npm package's run.js is a node script; a native build does not)? */
export function needsNodeFor(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, 128, 0);
    const head = buf.subarray(0, n).toString('latin1');
    return head.startsWith('#!') && /node/.test(head.split('\n')[0]);
  } catch {
    return true; // cannot tell: ask for node rather than claim it works
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The npm gws is run.js plus a native binary its postinstall downloads into bin/. An install that stopped before the
 * download leaves run.js linked and no binary: gws "exists" but every call tries to download it again.
 */
export function halfInstalled(p) {
  const rp = real(p);
  if (!rp || path.basename(rp) !== 'run.js') return false;
  return !isExec(path.join(path.dirname(rp), 'bin', 'gws'));
}

/** PATH from the user's login shell (interactive, so .zshrc runs too). Cached until `force`; [] when unreadable. */
export function loginShellPath({ shell = process.env.SHELL || '/bin/zsh', timeoutMs = 6000, force = false } = {}) {
  if (shellPathCache && !force) return Promise.resolve(shellPathCache);
  return new Promise((resolve) => {
    // No stdin (a profile that asks a question gets EOF, not a hang), its own process group so a timeout reaps
    // anything the profile started, and only the text between the markers is read (profiles print banners).
    let child;
    try {
      // From the home folder: a profile that adds "$PWD/bin" must not pick up whatever folder Dobius was started in.
      // And with a plain system PATH, so folders Dobius inherited from whatever shell launched it (a project's bin)
      // never come back as places to run npm or node from: only what the person's own profile sets up counts.
      child = spawn(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: HOME, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
    } catch (e) {
      console.warn('[gws-setup] login shell not started:', e?.code || e?.message);
      resolve(shellPathCache || []);
      return;
    }
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const m = out.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
      if (!m) { console.warn('[gws-setup] login shell PATH not read'); resolve(shellPathCache || []); return; }
      shellPathCache = m[1].split(':').filter((d) => d.startsWith('/'));
      resolve(shellPathCache);
    };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } finish(); }, timeoutMs);
    child.stdout.on('data', (c) => { out = (out + String(c)).slice(-65536); if (out.split(MARK).length >= 3) finish(); });
    child.on('error', finish);
    child.on('exit', finish);
  });
}

/** The newest nvm node's bin (by version folder name), or null. */
function nvmBin(home) {
  const root = path.join(home, '.nvm', 'versions', 'node');
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }
  const v = (n) => n.replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  names.sort((a, b) => { const x = v(a); const y = v(b); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return y[i] - x[i]; return 0; });
  return names.length ? path.join(root, names[0], 'bin') : null;
}

/**
 * Every folder gws or node might be in, most specific first, without duplicates. Pure apart from the nvm folder read.
 * `npmPrefix`: npm's global prefix (its bin is where `npm i -g` puts gws).
 */
export function candidateDirs({ home = HOME, shellDirs = [], npmPrefix = null } = {}) {
  const list = [
    ...shellDirs,
    ...(npmPrefix ? [path.join(npmPrefix, 'bin')] : []),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    nvmBin(home),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.local', 'bin'),
    ...STATIC_DIRS,
  ];
  return [...new Set(list.filter((d) => typeof d === 'string' && d.startsWith('/')))];
}

/** Is this a Dobius gws shim (ours or another Dobius copy's)? Its wrapper names DOBIUS_GWS_SHIM_SELF. */
export function isDobiusShim(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    return buf.subarray(0, n).toString('latin1').includes('DOBIUS_GWS_SHIM_SELF');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The first executable `name` in `dirs` that is not (through links) inside `skipDir`, the shim's own folder. For gws,
 * any Dobius shim is skipped too: another Dobius copy's shim on PATH would otherwise be run as "gws" (Codex round 4).
 */
export function findIn(dirs, name, skipDir = null) {
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    if (isExec(p) && !isInside(p, skipDir) && !(name === 'gws' && isDobiusShim(p))) return p;
  }
  return null;
}

// gws 0.22.5 declares node >=18 (its run.js uses syntax older ones cannot parse).
export const MIN_NODE_MAJOR = 18;
const nodeVersionCache = new Map(); // realpath|mtime -> major or 0
function nodeMajor(p) {
  const rp = real(p);
  let key = rp;
  try { key = `${rp}|${fs.statSync(rp).mtimeMs}`; } catch { /* gone */ }
  if (nodeVersionCache.has(key)) return Promise.resolve(nodeVersionCache.get(key));
  return new Promise((resolve) => {
    // With node's own folder and the system ones only: a node that is a wrapper script (#!/usr/bin/env bash) must not
    // pick up a program from a folder Dobius inherited.
    execFile(p, ['--version'], { timeout: 5000, cwd: HOME, env: { ...process.env, PATH: `${path.dirname(p)}:/usr/bin:/bin:/usr/sbin:/sbin` } }, (err, stdout) => {
      const m = !err && String(stdout).trim().match(/^v(\d+)\./);
      const major = m ? Number(m[1]) : 0;
      nodeVersionCache.set(key, major);
      resolve(major);
    });
  });
}

/** The first node in `dirs` new enough for gws, else the first node at all (so the panel can say it is too old). */
async function pickNode(dirs) {
  let first = null;
  for (const d of dirs) {
    const p = path.join(d, 'node');
    if (!isExec(p)) continue;
    const major = await nodeMajor(p);
    if (!first) first = { path: p, major };
    if (major >= MIN_NODE_MAJOR) return { path: p, major };
  }
  return first;
}

// npm's global prefix (where `npm i -g` puts gws), read without running npm: running a program found on PATH just
// to look is how a planted one would get in. NPM_CONFIG_PREFIX, then `prefix=` in ~/.npmrc. A default prefix needs
// nothing here: its bin is the folder node itself is in, which is already searched.
export function npmPrefix({ env = process.env, home = HOME } = {}) {
  const fromEnv = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
  try {
    // npm takes the LAST prefix= line.
    const all = [...fs.readFileSync(path.join(home, '.npmrc'), 'utf8').matchAll(/^\s*prefix\s*=\s*(.+?)\s*$/gm)];
    const m = all[all.length - 1];
    if (m) {
      // A quoted value is taken whole. Unquoted, it is read the way npm's ini reader does: a backslash escapes only
      // # ; and itself (any other backslash is literal), and an unescaped # or ; starts a comment. Then ~, ${VAR}
      // and $HOME are expanded.
      const raw = m[1];
      const q = raw.match(/^(["'])(.*)\1(?:\s*[#;].*)?$/);
      let text = '';
      if (q) text = q[2];
      else {
        for (let i = 0; i < raw.length; i += 1) {
          const ch = raw[i];
          if (ch === '\\' && '#;\\'.includes(raw[i + 1] ?? '')) { text += raw[i + 1]; i += 1; continue; }
          if (ch === '#' || ch === ';') break;
          text += ch;
        }
        text = text.trim();
      }
      const v = text.replace(/^~(?=\/|$)/, home)
        .replace(/\$\{(\w+)\}|\$(HOME)\b/g, (all, a, b) => { const k = a || b; return k === 'HOME' ? home : (env[k] ?? all); });
      if (path.isAbsolute(v)) return v;
    }
  } catch { /* no ~/.npmrc */ }
  return null;
}

let refreshing = null;
/**
 * Look again: login-shell PATH, npm's global prefix, the usual folders, a gws located by hand. Updates the state every
 * gws caller uses and the hint file the shim and the Claude Desktop server read. Returns the new state. `force` (Check
 * again, after an install) also reads the login shell again, so a folder added to .zshrc since launch is seen.
 */
export async function refreshGwsEnv(opts = {}) {
  // Callers that arrive together (the Setup panel and the Claude Desktop row load at once) share one look; a forced
  // look waits for the one in flight and then makes its own.
  if (refreshing) {
    const prev = refreshing;
    if (!opts.force) return prev;
    await prev.catch(() => {});
    if (refreshing && refreshing !== prev) return refreshing;
  }
  refreshing = doRefresh(opts).finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh({ force = false } = {}) {
  if (WIN) return { ...state }; // Windows finds gws on its own PATH; Setup is not shown there
  if (force) nodeVersionCache.clear(); // Volta and friends switch versions without touching their node shim
  const skipDir = hintDir;
  const shellDirs = FAKE_DIRS ? [] : await loginShellPath({ force });
  const look = (o) => (FAKE_DIRS ? [...new Set([...FAKE_DIRS, ...(o.npmPrefix ? [path.join(o.npmPrefix, 'bin')] : [])])] : candidateDirs(o));
  const located = userGws && isExec(userGws) && !isInside(userGws, skipDir) && !isDobiusShim(userGws) ? userGws : null;
  let dirs = look({ shellDirs, npmPrefix: npmPrefix() });
  const found = dirs.map((d) => findIn([d], 'gws', skipDir)).filter(Boolean);
  // Prefer one that can actually run: complete, and native or with a node new enough for it. A launcher that would
  // fail (half installed, or no node for it) must never shadow a working gws further down; a half one only when it is
  // all there is.
  const anyNode = found.some((p) => needsNodeFor(p)) ? await pickNode(dirs) : null;
  const nodeUsable = !!anyNode && anyNode.major >= MIN_NODE_MAJOR;
  const runs = (p) => !halfInstalled(p) && (!needsNodeFor(p) || nodeUsable);
  const gws = located || found.find(runs) || found.find((p) => !halfInstalled(p)) || found[0] || null;
  // `#!/usr/bin/env node` takes the first node on PATH, so the folder of a node new enough for gws goes first (the
  // node beside a discovered gws, as with nvm, when that one qualifies). A gws picked with Locate is run by its full
  // path and adds NO folder to PATH: whatever sits beside it (in Downloads, say) is never run as node or anything
  // else. A native gws needs no node at all.
  const needsNode = gws ? needsNodeFor(gws) : true;
  const node = needsNode ? await pickNode(gws && gws !== located ? [path.dirname(gws), ...dirs] : dirs) : null;
  dirs = [...new Set([...(node && node.major >= MIN_NODE_MAJOR ? [path.dirname(node.path)] : []), ...(gws && gws !== located ? [path.dirname(gws)] : []), ...dirs])];
  state = { dirs, gws, node: node?.path || null, nodeMajor: node?.major || 0, npm: findIn(dirs, 'npm'), needsNode, halfInstalled: gws ? halfInstalled(gws) : false, pathString: dirs.join(':') };
  looked = true;
  writeHint();
  return { ...state };
}

/** The current state (refreshGwsEnv keeps it current). */
export const gwsState = () => ({ ...state });

/** Join PATH parts, never with an empty entry (an empty entry means the current folder, so a project's `node`). */
export const joinPath = (...parts) => parts.flatMap((p) => String(p || '').split(':')).filter((d) => d.startsWith('/')).join(':');

/** The env every gws call in main uses: the found PATH first, so node and gws resolve as in a terminal. */
export function gwsExecEnv(extra = {}) {
  if (WIN) return { ...process.env, ...extra }; // the folders above are Mac ones
  return { ...process.env, ...extra, PATH: joinPath(state.pathString, process.env.PATH) };
}

/** The gws to run (its full path), or the bare name when none was found (the error then says "not found"). */
export const gwsCommand = () => state.gws || 'gws';

/** Where gws-env.json goes (the shim folder). Also brings back a gws picked with Locate before a restart. */
export function setHintDir(dir) {
  if (hintDir === dir) return;
  hintDir = dir;
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(dir, 'gws-env.json'), 'utf8'));
    if (!userGws && typeof prev?.located === 'string' && validLocated(prev.located)) userGws = prev.located;
  } catch { /* no earlier hint */ }
  // Nothing is written here: the last good hint stays until a look has run, so the shim and Claude Desktop keep working
  // while Dobius starts (writing the not-yet-looked state would tell them there is no gws).
  if (looked) writeHint();
}

/** Write a file through a fresh, exclusive temp file (never through a link planted at a guessable name), then rename. */
function writeExclusive(file, data, mode) {
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, data); // writes it all (writeSync may stop short on a full disk)
    fs.fchmodSync(fd, mode);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* gone */ } // never leave a partial copy of a secret behind
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw err;
  }
}

function writeHint() {
  if (!hintDir) return;
  try {
    fs.mkdirSync(hintDir, { recursive: true });
    const located = userGws && validLocated(userGws) ? userGws : null;
    writeExclusive(path.join(hintDir, 'gws-env.json'), JSON.stringify({ gws: state.gws, path: state.pathString, located, at: Date.now() }), 0o644);
  } catch (err) {
    console.warn('[gws-setup] could not write gws-env.json:', err?.code || err?.message);
  }
}

function validLocated(p) {
  const base = path.basename(p);
  return (base === 'gws' || base === 'run.js') && isExec(p) && !isInside(p, hintDir) && !isDobiusShim(p);
}

/** "Locate gws…": a file the person picked. Must be an executable named gws (or run.js of the package), not the shim. */
export async function useGwsAt(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return { ok: false, error: 'Pick the gws program itself.' };
  const base = path.basename(p);
  if (base !== 'gws' && base !== 'run.js') return { ok: false, error: 'That is not gws (the file is named gws, or run.js inside @googleworkspace/cli).' };
  if (!isExec(p)) return { ok: false, error: 'That file is not executable.' };
  if (isInside(p, hintDir) || isDobiusShim(p)) return { ok: false, error: "That is Dobius's own gws helper, not gws itself. Pick the real one, or use Install gws." };
  userGws = p;
  const s = await refreshGwsEnv({ force: true });
  return { ok: s.gws === p, gws: s.gws, error: s.gws === p ? null : 'Could not use that file.' };
}

// ---------- install ----------

let installing = null;
let lastInstall = null; // { ok, error, output, at }: shown by a panel opened after the install ended
export const isInstalling = () => !!installing;
/**
 * `npm i -g @googleworkspace/cli` with the found PATH. One at a time. Resolves { ok, gws, output, error }; `output` is
 * the last lines of npm's output, for the panel to show when it fails.
 */
export function installGws() {
  if (installing) return installing;
  installing = (async () => {
    await refreshGwsEnv({ force: true });
    if (!state.npm) {
      return { ok: false, error: 'Node.js (which includes npm) is not installed. Install it from nodejs.org, then press Check again.', needsNode: true };
    }
    // npm is a node script: only run it with a node Dobius found and checked, first on its PATH, never whatever
    // `node` an inherited folder happens to hold.
    const vetted = state.node && state.nodeMajor >= MIN_NODE_MAJOR ? state.node : (await pickNode(state.dirs))?.path;
    if (!vetted || (await nodeMajor(vetted)) < MIN_NODE_MAJOR) {
      return { ok: false, error: `gws needs Node.js ${MIN_NODE_MAJOR} or newer. Install the current Node.js LTS from nodejs.org, then press Check again.`, needsNode: true };
    }
    const out = await new Promise((resolve) => {
      let text = '';
      let child;
      try {
        // Its own process group, so a timeout reaps npm's postinstall children too.
        child = spawn(state.npm, ['install', '-g', GWS_PACKAGE], { env: { ...process.env, PATH: joinPath(path.dirname(vetted), state.pathString, '/usr/bin:/bin:/usr/sbin:/sbin') }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, cwd: HOME });
      } catch (e) {
        resolve({ code: -1, text: String(e?.message || e) });
        return;
      }
      let settled = false;
      const settle = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
      const keep = (c) => { text = (text + String(c)).slice(-6000); };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      // Five minutes, then TERM the whole group, KILL it 5s later, and give up waiting either way: the panel must
      // never stay on Installing forever.
      const timer = setTimeout(() => {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 5000).unref?.();
        setTimeout(() => settle({ code: -1, text: `${text}\nThe install took more than 5 minutes and was stopped.` }), 6000).unref?.();
      }, 5 * 60_000);
      child.on('error', (e) => settle({ code: -1, text: `${text}\n${e?.message || e}` }));
      child.on('exit', (code) => settle({ code, text }));
    });
    // What npm just installed beats an earlier Locate pick (which may be the broken copy this install replaces).
    if (out.code === 0) userGws = null;
    const s = await refreshGwsEnv({ force: true });
    const tail = out.text.trim().split('\n').slice(-12).join('\n');
    if (out.code === 0 && s.gws && !s.halfInstalled) return { ok: true, gws: s.gws, output: tail };
    const perm = /EACCES|permission denied/i.test(out.text);
    return {
      ok: false,
      output: tail,
      error: out.code === 0 && s.halfInstalled
        ? "npm installed gws but skipped the step that downloads its program (is ignore-scripts set in ~/.npmrc?). Remove that setting, then press Install gws again."
        : perm
        ? "npm could not write to its global folder (a permissions problem). Run `npm i -g @googleworkspace/cli` in a terminal (with sudo if npm's folder needs it), then press Check again."
        : out.code === 0 ? 'npm finished, but gws still was not found. Use Locate gws… to point at it.' : 'Installing gws failed. The npm output is below.',
    };
  })().then((r) => { lastInstall = { ...r, at: Date.now() }; return r; }).finally(() => { installing = null; });
  return installing;
}

// ---------- the OAuth client file ----------

/** { project, clientIdTail, kind } for a usable client file (links followed), else null. Never returns the secret. */
export function readClientFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const c = j.installed || j.web;
    if (!c || typeof c.client_id !== 'string' || typeof c.client_secret !== 'string' || !c.client_id.trim() || !c.client_secret.trim()) return null;
    // gws signs in with a desktop client (loopback redirect); a Web application client is reported so the panel can
    // say why it will not do, but it never counts as ready. gws 0.22.5's loader needs project_id, auth_uri and token_uri;
    // redirect_uris and auth_provider_x509_cert_url may be absent but not of another type. Others are 'incomplete'.
    const complete = ['project_id', 'auth_uri', 'token_uri'].every((k) => typeof c[k] === 'string')
      && (c.redirect_uris === undefined || (Array.isArray(c.redirect_uris) && c.redirect_uris.every((u) => typeof u === 'string')))
      && (c.auth_provider_x509_cert_url === undefined || typeof c.auth_provider_x509_cert_url === 'string');
    const kind = !j.installed ? 'web' : complete ? 'desktop' : 'incomplete';
    return { project: typeof c.project_id === 'string' ? c.project_id : null, clientIdTail: c.client_id.slice(0, 12), kind };
  } catch {
    return null;
  }
}

/** Client files already on this Mac that could be used: other ~/.config/gws* folders and ~/Downloads. */
export function findClientFiles({ home = HOME, target = gwsClientSecretPath() } = {}) {
  const out = [];
  const consider = (p) => { const info = readClientFile(p); if (info?.kind === 'desktop' && p !== target) out.push({ path: p, ...info }); };
  try {
    for (const d of fs.readdirSync(path.join(home, '.config'))) {
      if (/^gws/.test(d)) consider(path.join(home, '.config', d, 'client_secret.json'));
    }
  } catch { /* no ~/.config */ }
  try {
    for (const f of fs.readdirSync(path.join(home, 'Downloads'))) {
      if (/^client_secret.*\.json$/i.test(f)) consider(path.join(home, 'Downloads', f));
    }
  } catch { /* no Downloads */ }
  return out.slice(0, 10);
}

/** Copy a chosen or found client file to ~/.config/gws/client_secret.json (dir 700, file 600). */
export function useClientFile(p, { target = gwsClientSecretPath() } = {}) {
  const info = readClientFile(p);
  if (!info) return { ok: false, error: 'That is not a Google OAuth client file (client_secret*.json with a client_id and client_secret).' };
  if (info.kind === 'incomplete') return { ok: false, error: 'That client file is missing fields gws needs (project_id, auth_uri, token_uri). Download it again from Google Cloud, Credentials, the download button on your Desktop client.' };
  if (info.kind !== 'desktop') return { ok: false, error: 'That is a Web application client. gws needs a Desktop app client: in Google Cloud, Create OAuth client, Application type Desktop app, then download that one.' };
  try {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The secret only goes into a folder that is really ours and nobody else can write to.
    const dst = fs.lstatSync(dir);
    if (dst.isSymbolicLink() || !dst.isDirectory()) return { ok: false, error: `${dir} is not a plain folder; fix it first.` };
    if (typeof process.getuid === 'function' && dst.uid !== process.getuid()) return { ok: false, error: `${dir} belongs to another user.` };
    if (dst.mode & 0o022) fs.chmodSync(dir, 0o700);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return { ok: false, error: `${target} is a link; remove it first.` };
    } catch { /* not there yet */ }
    writeExclusive(target, fs.readFileSync(p), 0o600);
    return { ok: true, ...info };
  } catch (err) {
    return { ok: false, error: `Could not copy it: ${err?.code || err?.message}` };
  }
}

/**
 * The project_id gws itself would read from a client file, by gws 0.22.5's loader: an `installed` client whose
 * client_id, client_secret, project_id, auth_uri and token_uri are strings (empty allowed, unlike Setup's check) and
 * whose optional redirect_uris / auth_provider_x509_cert_url have the right types. Null when gws could not load it.
 */
export function gwsLoadableProject(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))?.installed;
    if (!c || !['client_id', 'client_secret', 'project_id', 'auth_uri', 'token_uri'].every((k) => typeof c[k] === 'string')) return null;
    if (c.redirect_uris !== undefined && !(Array.isArray(c.redirect_uris) && c.redirect_uris.every((u) => typeof u === 'string'))) return null;
    if (c.auth_provider_x509_cert_url !== undefined && typeof c.auth_provider_x509_cert_url !== 'string') return null;
    return c.project_id || null;
  } catch {
    return null;
  }
}

/**
 * The project gws will send as the quota project, in gws's own order (0.22.5 auth.rs get_quota_project): a non-empty
 * GOOGLE_WORKSPACE_PROJECT_ID, then the client file's project_id (gws's older ~/Library/Application Support/gws folder
 * when ~/.config/gws does not exist), then quota_project_id from gcloud's default credentials. Null when none.
 */
export function effectiveQuotaProject(env = process.env) {
  if (env.GOOGLE_WORKSPACE_PROJECT_ID) return env.GOOGLE_WORKSPACE_PROJECT_ID;
  const fromFile = gwsLoadableProject(gwsClientSecretPath(env));
  if (fromFile) return fromFile;
  try {
    // Set at all (even empty) means gws reads that path and nothing else.
    const adc = env.GOOGLE_APPLICATION_CREDENTIALS !== undefined ? env.GOOGLE_APPLICATION_CREDENTIALS : path.join(HOME, '.config', 'gcloud', 'application_default_credentials.json');
    if (!adc) return null;
    const q = JSON.parse(fs.readFileSync(adc, 'utf8'))?.quota_project_id;
    return typeof q === 'string' && q ? q : null;
  } catch {
    return null;
  }
}

/** Does gws itself report a client config (one set up some other way)? Read-only; never logs what gws prints. */
function gwsReportsClient() {
  return new Promise((resolve) => {
    if (!state.gws) { resolve(false); return; }
    execFile(state.gws, ['auth', 'status'], { env: gwsExecEnv(), timeout: 10000 }, (err, stdout) => {
      if (err) { resolve(false); return; }
      // gws can print a line before the JSON; read from the first brace.
      const text = String(stdout);
      try { resolve(JSON.parse(text.slice(text.indexOf('{'))).client_config_exists === true); } catch { resolve(false); }
    });
  });
}

/**
 * Windows: npm installs gws as a .cmd that Node will not start without a shell, so Dobius runs its JS entry under its
 * own Electron binary (no separate node needed). The entry from the package's own bin map (it has moved between
 * releases), then the known names, under %APPDATA%\npm. Null when gws is not installed there.
 */
export function windowsGwsEntry(env = process.env) {
  if (!env.APPDATA) return null;
  const pkgDir = path.join(env.APPDATA, 'npm', 'node_modules', '@googleworkspace', 'cli');
  const candidates = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.gws;
    if (typeof bin === 'string' && bin) candidates.push(path.join(pkgDir, bin));
  } catch { /* no package.json: the literals below */ }
  candidates.push(path.join(pkgDir, 'run.js'), path.join(pkgDir, 'bin', 'gws'));
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.R_OK); return c; } catch { /* next */ }
  }
  return null;
}

/** Everything the Settings panel needs to say what is set up and what is not. */
export async function gwsSetupStatus(opts = {}) {
  if (WIN) {
    // Max, 2026-11-07 (Windows beta): Add Google Account failed with a generic message because no OAuth client was
    // set up. Windows gets the same checklist: gws (under %APPDATA%\npm, run by Dobius itself) and the client file.
    // npm's run.js (run by Dobius itself), else a native gws.exe on PATH (gwsCommand's fallback).
    const entry = windowsGwsEntry() || findIn(String(process.env.PATH || '').split(';').filter(Boolean), 'gws.exe');
    const clientPath = gwsClientSecretPath();
    const fileClient = readClientFile(clientPath);
    // gws's own order: a client in the environment (both variables set) beats the file.
    const envId = process.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID;
    const envSecret = process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET;
    const envSet = envId !== undefined && envSecret !== undefined;
    const envClient = envSet && envId && envSecret ? { project: null, clientIdTail: String(envId).slice(0, 12), kind: 'env' } : null;
    const client = envSet ? envClient : (fileClient?.kind === 'desktop' ? fileClient : null);
    return {
      windows: true,
      gws: entry, node: entry ? process.execPath : null, npm: null, needsNode: false, nodeMajor: 0, nodeTooOld: false,
      halfInstalled: false, minNode: MIN_NODE_MAJOR,
      client: client ? { path: clientPath, ...client } : null,
      envClientEmpty: envSet && !envClient,
      webClient: !client && fileClient?.kind === 'web',
      webClientPath: !client && fileClient?.kind === 'web' ? clientPath : null,
      incompleteClient: !client && fileClient?.kind === 'incomplete',
      clientCandidates: client ? [] : findClientFiles(),
      installing: false, lastInstall: null,
      ready: !!entry && !!client,
    };
  }
  const s = await refreshGwsEnv(opts);
  // A client given to gws by environment (GOOGLE_WORKSPACE_CLI_CLIENT_ID/_SECRET) works without the file, and so does
  // one gws reports having from its own setup.
  const nodeOk = !s.needsNode || (!!s.node && s.nodeMajor >= MIN_NODE_MAJOR);
  // gws uses the variables whenever they are set, even empty, so set-but-empty means no usable client.
  const envId = process.env.GOOGLE_WORKSPACE_CLI_CLIENT_ID;
  const envSecret = process.env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET;
  const envSet = envId !== undefined && envSecret !== undefined;
  const envClient = envSet && envId && envSecret ? { project: null, clientIdTail: String(envId).slice(0, 12), kind: 'env' } : null;
  // gws's own order: a client in the environment beats the file.
  const clientPath = gwsClientSecretPath();
  const fileClient = readClientFile(clientPath);
  let client = envSet ? envClient : (fileClient?.kind === 'desktop' ? fileClient : null);
  // Only when there is no client file at all: gws reports client_config_exists for a file it cannot use, too.
  // Never ask a half-installed launcher (it would start its own download) or one mid-install.
  // Never ask a gws that cannot run cleanly yet (no usable node: whatever `node` PATH finds would run).
  if (!client && !envSet && !fs.existsSync(clientPath) && s.gws && !s.halfInstalled && !isInstalling() && nodeOk && await gwsReportsClient()) client = { project: null, clientIdTail: null, kind: 'gws' };
  return {
    gws: s.gws,
    node: s.node,
    npm: s.npm,
    needsNode: s.needsNode,
    nodeMajor: s.nodeMajor || 0,
    nodeTooOld: !!s.node && s.nodeMajor < MIN_NODE_MAJOR && (s.needsNode || !s.gws),
    halfInstalled: !!s.halfInstalled,
    minNode: MIN_NODE_MAJOR,
    client: client ? { path: clientPath, ...client } : null,
    envClientEmpty: envSet && !envClient,
    webClient: !client && fileClient?.kind === 'web',
    webClientPath: !client && fileClient?.kind === 'web' ? clientPath : null,
    incompleteClient: !client && fileClient?.kind === 'incomplete',
    clientCandidates: client ? [] : findClientFiles(),
    installing: isInstalling(),
    lastInstall: lastInstall && Date.now() - lastInstall.at < 15 * 60_000 ? { ok: !!lastInstall.ok, error: lastInstall.error || null, output: lastInstall.output || null } : null,
    // Not while an install runs: npm links gws before its postinstall has fetched the real binary.
    ready: !isInstalling() && !!s.gws && !s.halfInstalled && nodeOk && !!client,
  };
}

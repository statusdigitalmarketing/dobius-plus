import pty from 'node-pty';
import { trackPasteMode } from './paste-mode.js';
import { oscScanState, chunkMayDraw } from './osc-only.js';
import { isTerminalReply, createVisibleOutputScanner } from './terminal-reply.js';
import { isClaudeCommand, classifyClaudeProcess } from './claude-argv.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Promise-based subprocess execution. Replaces the previous execFileSync
// callers because the sync version blocks the main thread on every call,
// which under load became a noticeable typing-latency contributor (the
// 3s-per-tab process-detection poll in TerminalTabBar was firing ~12-30 sync
// pgrep calls per second across many tabs).
const execFileP = promisify(execFile);
import { app } from 'electron';
import { getSessionTabMap } from './config-manager.js';
import { loginShellSpawn, ptyProgramName } from '../shared/new-tab.js';
import { parseCodexCommand } from './codex-sessions.js';
import { sharedKeyEnv, SHARED_KEYS } from './claude-settings-env.js';
import { sameFiletime, recordStartFiletime, winProcessTable, shellPrograms, descendants, winClaudeCommand, winCodexCommand, winExeBase } from './win-proc.js';
import { readPresenceRecordAt, presenceSessionId } from './claude-presence.js';

const IS_WIN = process.platform === 'win32';

// The shell a Windows tab runs: PowerShell 7 (pwsh) when installed, else the
// Windows PowerShell every Windows has. $SHELL is ignored on Windows (Git
// Bash sets it to a path Windows cannot spawn).
function windowsShell() {
  for (const dir of String(process.env.Path || process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'pwsh.exe');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const terminals = new Map();
// getTerminalClaudeInfo { unique }: a shell with more children answers nothing.
const MAX_UNIQUE_CHILDREN = 16;

// Global terminal observers (v1.0.43): sinks that see EVERY terminal's data +
// exit, independent of window/mobile attachment. Used by the main-process
// status authority. Each observer is { onData(id, data, cwd), onExit(id,
// {exitCode, signal, cwd}), onSpawn(id) }.
const terminalObservers = new Set();
export function addTerminalObserver(observer) {
  if (observer) terminalObservers.add(observer);
  return () => terminalObservers.delete(observer);
}

// Sinks that see every write INTO a terminal (id, data), from any surface.
// /openTab uses it to notice a person typing into the tab it opened.
const inputObservers = new Set();
export function addInputObserver(fn) {
  if (typeof fn === 'function') inputObservers.add(fn);
  return () => inputObservers.delete(fn);
}

/**
 * Defensive startup check: node-pty's `spawn-helper` MUST be executable or
 * every PTY opens blank (the helper is exec'd to launch the shell, and without
 * +x that exec fails with EACCES). electron-builder's asar-unpack step has been
 * seen to drop the bit, and an external file copy (scp/rsync) or a recursive
 * chmod can do the same. Re-assert 0755 on launch so neither a bad build nor an
 * accidental permission change can leave the user with dead terminals again.
 * Safe to call every launch (chmod on an already-correct file is a no-op) and
 * only touches a file inside our own app bundle. Returns true if the helper is
 * executable afterward.
 */
export function ensureSpawnHelperExecutable() {
  if (IS_WIN) return; // spawn-helper is the macOS/Linux launcher; Windows uses ConPTY
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')
      : null,
    path.join(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
  ].filter(Boolean);

  let ok = false;
  for (const helper of candidates) {
    try {
      if (!fs.existsSync(helper)) continue;
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
        console.warn(`[terminal-manager] spawn-helper was not executable; restored 0755: ${helper}`);
      }
      ok = true;
    } catch (err) {
      console.error(`[terminal-manager] spawn-helper check failed for ${helper}:`, err.message);
    }
  }
  if (!ok) {
    console.error('[terminal-manager] WARNING: node-pty spawn-helper not found or not fixable; terminals may open blank.');
  }
  return ok;
}

// Per-terminal rolling output buffer cap (bytes). Replayed to a freshly-
// attached mobile client so it has real scrollback, not just the last screen.
// 1MB is roughly 10-15k lines of terminal text.
const OUTPUT_BUFFER_BYTES = 1024 * 1024;
// Cap kept even when NO mobile client is subscribed, so the FIRST phone attach
// to a desktop-only or idle tab replays a real screen, not a blank one (audit
// HIGH-3). Raised 64KB -> 512KB (v1.0.72): Claude Code repaints its live region
// with cursor-up + column-positioning in the MAIN buffer (no alt-screen, no
// clear-screen), so the phone can only reconstruct the screen if the replayed
// tail contains a COMPLETE frame. During heavy reasoning a single frame can
// exceed 64KB, so the 64KB tail started mid-frame and the phone painted a
// partial grid: the "grey screen with only the cursor and a fragment" Sam
// reported. 512KB holds several large frames. Still far under the 1MB
// subscribed cap, and only idle tabs pay it.
const IDLE_BUFFER_BYTES = 512 * 1024;

// How far trimToEscapeBoundary will skip to reach a safe resync point. A cut
// inside a sequence leaves only a few bytes before the next ESC, so a genuine
// resync is close. Beyond this the cut landed in ordinary text, which is
// already safe, and skipping would throw away real output.
const ESC_RESYNC_WINDOW = 2048;


/**
 * Create a new terminal session.
 * @param {string} id — unique terminal ID
 * @param {string} cwd — working directory
 * @param {Electron.WebContents} webContents — renderer to send data to
 * @returns {{ pid: number }}
 */
/**
 * Keep the last `cap` chars of the rolling replay buffer, but never let it
 * BEGIN in the middle of an ANSI escape sequence.
 *
 * Why this matters (Sam, mobile: garbled terminal with stray digits inside
 * words). The buffer is a raw byte log that a freshly attached phone replays
 * into an empty xterm. A plain `.slice(-cap)` cuts at an arbitrary offset, so
 * the replay can start inside a sequence like `ESC [ 38;2;211;218;255 m`. The
 * parser starts in ground state, so the leftover parameters PRINT AS TEXT
 * (this is the `backgro8` / `backgro30` / `a38;2;211;218;` the phone showed),
 * and, worse, the truncated sequence never moves the cursor where the CLI
 * believes it is. Claude Code positions its live region RELATIVELY (cursor-up
 * N, then redraw), so one lost move desyncs the cursor permanently and every
 * later frame lands on the wrong rows: the incremental frames pile up on
 * screen ("W Wa Wai Wait Waiti Waitin Waiting") instead of overwriting.
 *
 * You cannot tell from the bytes alone whether a cut landed inside a sequence:
 * a pattern loose enough to catch the fragments also eats ordinary text
 * ("prefix123abc" cut to "123abc" looks exactly like CSI parameters plus a
 * final byte), and a pattern tight enough to spare text misses fragments like a
 * bare "[31m" or an OSC payload tail. Both were measured.
 *
 * So do not guess: resync to a position that is safe BY CONSTRUCTION. An ESC
 * can only begin a new sequence, so the parser is in a known state there. After
 * cutting, skip forward to the first ESC. The cost is that the few characters
 * between the cut and that ESC are dropped, which is the oldest end of a replay
 * tail and not worth a garbled screen. The skip is bounded, so a long run of
 * plain text (a build log) is left alone rather than discarded: with no escape
 * nearby the cut is in ordinary text and is already safe to start from.
 *
 * Residual: a cut inside an OSC payload LONGER than the window still prints
 * some payload text. OSC payloads are titles, they do not move the cursor, so
 * that is cosmetic rather than the screen-destroying cursor desync above.
 */
// Also inside a combined mode list (ESC [ ? 25 ; 1049 h): Codex High.
const ALT_SCREEN_RE = /\x1b\[\?(?:[0-9;]*;)?(?:1049|1047|47)(?:;[0-9;]*)?([hl])/g;

/** Whether the tab's program has bracketed paste on right now (tracked over ALL its output, not the buffer). */
export function terminalBracketedPaste(id) {
  return !!terminals.get(id)?.pasteMode?.on;
}

/** Whether the tab's rolling output buffer begins inside the alternate screen. */
export function terminalAltAtBufferStart(id) {
  return !!terminals.get(id)?.altAtBufferStart;
}

/** Whether the tab's output buffer has dropped its oldest output. */
export function terminalBufferTrimmed(id) {
  return !!terminals.get(id)?.bufferTrimmed;
}

export function trimToEscapeBoundary(buf, cap) {
  if (buf.length <= cap) return buf;
  const cut = buf.slice(-cap);
  const esc = cut.indexOf('\x1b');
  return esc > 0 && esc <= ESC_RESYNC_WINDOW ? cut.slice(esc) : cut;
}

// startCommand: a New Tab's tool ('claude' | 'codex', from shared/new-tab.js
// launchCommandFor, never free text). The login shell runs it as its first
// command, after the rc files, then becomes a normal login shell when it exits.
// Nothing is typed into the terminal, so it can never land in a user's line,
// a startup prompt or a moved tab. claudeOpts ({ model, permissionMode }, shared/new-tab.js claudeLaunchOptions):
// the new tab's Claude defaults, allowlisted again inside loginShellSpawn.
export function createTerminal(id, cwd, webContents, accountEnv = {}, { startCommand = null, resume = null, runScript = null, claudeOpts = null, requireCwd = false } = {}) {
  // A respawn under an existing id (e.g. "Continue on switched account") must
  // NOT strand what was attached to the old PTY. Carry over the live subscriber
  // set so an attached phone keeps streaming (killing the old PTY would orphan
  // it: its onExit is suppressed by the identity guard, so the mobile socket
  // still thinks it is subscribed and receives nothing). Carry over the last
  // known geometry so the resumed shell renders at the tab's real size instead
  // of collapsing to 80x24 (reviewer P2 x2).
  const prev = terminals.get(id);
  const prevSubs = prev?.subscribers;
  const prevCols = prev?.cols;
  const prevRows = prev?.rows;
  // The screen keeps its parser state across a respawn, so the output scan does too: a fresh
  // PTY starts where the old one left the terminal (see electron/osc-only.js, Codex).
  // Kill existing terminal with this ID if any
  if (terminals.has(id)) {
    killTerminal(id, { respawn: true });
  }
  // A respawn under the same id starts fresh for observers (status timing).
  for (const obs of terminalObservers) {
    try { obs.onSpawn?.(id); } catch { /* never let an observer break the PTY */ }
  }

  // Validate cwd is an existing directory; fall back to home
  let safeCwd = os.homedir();
  if (cwd && typeof cwd === 'string') {
    try {
      const stat = fs.statSync(cwd);
      if (stat.isDirectory()) {
        safeCwd = cwd;
      }
    } catch {
      // Invalid path — use home directory
    }
  }

  // A New Tab's tool belongs to its project: never start it in the fallback.
  if (safeCwd !== cwd) { startCommand = null; resume = null; }
  // A phone Run terminal must start in the card's folder or not at all: home's login profile would set up the command's
  // environment (Codex phone tasks round 9). Checked here, at the last moment (a phone Run id is always new, so no
  // earlier PTY was killed above); node-pty itself fails the spawn if the folder goes in the instant after.
  if (requireCwd && safeCwd !== cwd) return null;

  // Per-project shell history file
  const extraEnv = {};
  if (id.startsWith('term-')) {
    const encodedProject = Buffer.from(safeCwd).toString('base64url');
    const histDir = path.join(app.getPath('userData'), 'terminal-history', encodedProject);
    try {
      fs.mkdirSync(histDir, { recursive: true });
    } catch {
      // Ignore — directory may already exist
    }
    extraEnv.HISTFILE = path.join(histDir, '.zsh_history');
  }
  // ASANA_PAT / FIREFLIES_API_KEY from Claude's settings.json env, so Codex and
  // plain shells have them too (Claude sessions read that file themselves).
  // The file decides: one it lacks is dropped from what Dobius inherited (see
  // below), so Remove in Settings really removes it; a shell rc that exports
  // it still sets it, since the login shell runs that rc.
  const sharedKeys = sharedKeyEnv(); // null: settings.json unreadable, leave inherited values
  if (sharedKeys) Object.assign(extraEnv, sharedKeys);

  // Electron's process.env.PATH is minimal when launched from Finder/Dock.
  // Prepend Homebrew paths so tools like zoxide, fzf, brew etc. are available.
  // If the account has a specific CLI path, prepend its directory first so
  // typing `claude` in the shell resolves to the account's binary.
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  if (accountEnv.DOBIUS_CLI_DIR) {
    extraPaths.unshift(accountEnv.DOBIUS_CLI_DIR);
  }
  // gws shim dir goes FIRST so `gws` resolves to the shim (v1.0.41). It sits
  // ahead of the account CLI dir too; they never collide (different binaries).
  if (accountEnv.DOBIUS_GWS_SHIM_DIR) {
    extraPaths.unshift(accountEnv.DOBIUS_GWS_SHIM_DIR);
  }
  // Per-instance helper commands (`dobius-tab`), installed by voice-bridge.
  extraPaths.push(tabBinDir());
  const pathKey = IS_WIN ? (Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'Path') : 'PATH';
  const fullPath = IS_WIN
    ? [...extraPaths.filter((p) => !p.startsWith('/')), process.env[pathKey] || '', ...windowsToolDirs(process.env[pathKey] || '')]
      .filter(Boolean).join(path.delimiter)
    : [...extraPaths, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');

  // These two are consumed here (into PATH), not passed as literal env vars.
  const { DOBIUS_CLI_DIR: _ignored, DOBIUS_GWS_SHIM_DIR: _ignored2, ...termEnv } = accountEnv;

  const shell = IS_WIN ? windowsShell() : (process.env.SHELL || '/bin/zsh');
  const baseEnv = { ...process.env };
  if (IS_WIN) for (const k of Object.keys(baseEnv)) { if (k.toUpperCase() === 'PATH') delete baseEnv[k]; }
  const spawnEnv = {
    ...baseEnv,
    [pathKey]: fullPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DOBIUS_CWD: safeCwd,
    // Which tab this shell is, so `dobius-tab` (run by an agent's Bash tool,
    // whose output never reaches the tty) can rename its own tab.
    DOBIUS_TAB_ID: id,
    // What Dobius gives an agent here (agent-context.js); the SessionStart hook prints it into Claude's context.
    DOBIUS_AGENT_CONTEXT: path.join(app.getPath('userData'), 'agent-context.md'),
    ...extraEnv,
    ...termEnv,
  };
  // A termEnv key set to undefined is a DELETION signal: e.g. a ChatGPT Codex
  // account must not inherit an OPENAI_API_KEY from Dobius's environment, which
  // would override its stored login. (A key re-exported by the login shell
  // profile is outside our reach; this clears the inherited case.)
  for (const [k, v] of Object.entries(termEnv)) { if (v === undefined) delete spawnEnv[k]; }
  if (sharedKeys) for (const k of SHARED_KEYS) { if (!(k in sharedKeys)) delete spawnEnv[k]; }
  // What this shell ACTUALLY launched with. Recorded from the FINAL spawn env,
  // after the undefined-means-delete pass above, so it reflects reality rather
  // than intent.
  //
  // It is recorded rather than recomputed later because resolveAccountEnvForCwd
  // performs profile-sharing side effects (it creates, merges and symlinks
  // files), so asking it "what would this tab use" just to render a badge or a
  // count would MUTATE profiles as a display operation.
  //
  // ABSENT is meaningful and distinct from any profile: it means the CLI's own
  // default dir. The CONFIGURED spelling is kept verbatim, never realpath'd,
  // because the Keychain item is keyed by a hash of that exact string.
  //
  // Claude and Codex are recorded independently: one shell carries both
  // bindings and they are selected separately.
  const accountBinding = {
    claudeConfigDir: typeof spawnEnv.CLAUDE_CONFIG_DIR === 'string' ? spawnEnv.CLAUDE_CONFIG_DIR : null,
    codexHome: typeof spawnEnv.CODEX_HOME === 'string' ? spawnEnv.CODEX_HOME : null,
  };
  const spawnCols = (Number.isInteger(prevCols) && prevCols > 0) ? prevCols : 80;
  const spawnRows = (Number.isInteger(prevRows) && prevRows > 0) ? prevRows : 24;
  // A carry-on goes out only on the folder this spawn sets: the shell checks it
  // after its startup files ran, since one of them may export another.
  // The folder that passed the move's checks must be the one this spawn set
  // (an account id remapped meanwhile is not).
  const carryOn = resume?.carryOn === true && typeof resume.configDir === 'string' && resume.configDir === (accountBinding.claudeConfigDir ?? '');
  const start = loginShellSpawn(shell, startCommand, resume?.carryOn === true ? { ...resume, carryOn } : resume, runScript, claudeOpts);
  const spawnedAt = Date.now();
  const term = pty.spawn(shell, start.args, {
    name: 'xterm-256color', cols: spawnCols, rows: spawnRows, cwd: safeCwd, env: { ...spawnEnv, ...start.env },
  });

  const dataSub = term.onData((data) => {
    const entry = terminals.get(id);
    // Identity guard: if this id was re-created (createTerminal killed the old
    // PTY and spawned a new one under the same id), the OLD pty's late onData
    // must not be routed as the replacement's output. Audit High.
    if (!entry || entry.pty !== term) return;
    if (entry.visibleScan(data)) entry.outputSeq = (entry.outputSeq || 0) + 1; // see terminalSettledSinceInput
    // Only output that can draw: a title or tab-status marker alone never changes the screen,
    // and counting it made a question card read as changed (see electron/osc-only.js).
    // A new PTY's output opens with CAN, which ends any escape or string the screen still has
    // open from an earlier PTY under this tab id (a respawn, or an exit then a re-create) and
    // draws nothing. Screen and scan then both start in ground state (Codex, three rounds).
    if (!entry.oscState) { entry.oscState = oscScanState(); data = `\x18${data}`; }
    if (chunkMayDraw(data, entry.oscState)) entry.rawOutputSeq = (entry.rawOutputSeq || 0) + 1; // see terminalRawOutputSeq
    entry.pasteMode = trackPasteMode(entry.pasteMode, data); // see terminalBracketedPaste
    // Global observers (main-process status authority, v1.0.43): see EVERY
    // terminal's output regardless of whether a window or mobile client is
    // attached, so tab status is tracked centrally. Cheap: observers do a
    // bounded string scan, no per-chunk allocation like the mobile buffer.
    for (const obs of terminalObservers) {
      try { obs.onData?.(id, data, entry.cwd); } catch { /* never let an observer break the PTY */ }
    }
    // Desktop window (unchanged path).
    if (entry.webContents && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:data', id, data);
    }
    // Rolling buffer for late mobile subscribers. Always maintained so the
    // FIRST phone attach to a desktop-only/idle tab replays a real screen, not a
    // blank one (audit HIGH-3). Keep only a screenful (64KB) when no phone is
    // subscribed; grow to full 1MB scrollback once one is. The slice bounds the
    // allocation either way, and the idle 64KB case is cheaper than the 1MB case
    // that was already accepted for subscribed tabs.
    const cap = entry.subscribers.size > 0 ? OUTPUT_BUFFER_BYTES : IDLE_BUFFER_BYTES;
    const combined = entry.outputBuffer + data;
    entry.outputBuffer = trimToEscapeBoundary(combined, cap);
    // Whether the KEPT buffer begins inside the alternate screen (vim, less):
    // its entry may have been trimmed away, and only the dropped part can say.
    if (entry.outputBuffer.length < combined.length) {
      // The buffer no longer holds everything this PTY printed (chat-service
      // then checks a replay covers the whole screen before trusting it).
      entry.bufferTrimmed = true;
      // Plus the kept buffer's first 8 characters (the longest switch is 8):
      // a switch split by the cut is seen whole here, whereas scanning only the
      // dropped part would miss it in both halves. Seeing one twice is harmless:
      // the state is the last switch either way.
      const cutAt = combined.length - entry.outputBuffer.length;
      const dropped = combined.slice(0, cutAt + 8);
      let last = null;
      for (const m of dropped.matchAll(ALT_SCREEN_RE)) last = m[1];
      if (last) entry.altAtBufferStart = last === 'h';
    }
    for (const sub of entry.subscribers) {
      try { sub.onData?.(id, data); } catch { /* drop bad subscriber silently */ }
    }
  });

  const exitSub = term.onExit(({ exitCode, signal }) => {
    const entry = terminals.get(id);
    // Identity guard: a killed PTY's onExit fires asynchronously. If the id was
    // already re-created (createTerminal kills old -> spawns new under same id),
    // entry.pty is the NEW live pty; deleting it here would kill the live
    // replacement and emit a bogus exit. Only act when this IS the current pty.
    // Audit High.
    if (!entry || entry.pty !== term) return;
    terminals.delete(id);
    // Global observers get the exit + the cwd BEFORE the entry is gone, so the
    // status authority can cache exit code/project for the mobile board.
    for (const obs of terminalObservers) {
      try { obs.onExit?.(id, { exitCode, signal, cwd: entry.cwd }); } catch { /* noop */ }
    }
    if (entry.webContents && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:exit', id, exitCode, signal);
    }
    for (const sub of entry.subscribers) {
      try { sub.onExit?.(id, exitCode, signal); } catch { /* noop */ }
    }
  });

  terminals.set(id, {
    pty: term,
    visibleScan: createVisibleOutputScanner(), // escape state spans chunks
    // node-pty routes onData/onExit through a NAPI ThreadSafeFunction. If a
    // callback lands while Node is freeing its environment at quit, the throw
    // has no handler and the process dies with SIGABRT ("Dobius+ quit
    // unexpectedly"), which is exactly what the Restart button produced with
    // several windows open (crash reports 2026-08-10: pty.node ->
    // ThrowAsJavaScriptException inside node::Environment::CleanupHandles).
    // Keeping the disposables lets shutdown UNREGISTER the JS callbacks before
    // killing the PTYs, so the late callbacks have nothing to call into.
    disposables: [dataSub, exitSub],
    webContents,
    // True once this PTY has ever been bound to a desktop window (created with a
    // webContents, or later claimed by one). Headless PTYs (voice-conductor
    // background agents, phone-spawned terminals) are created with webContents
    // null and never claimed, so this stays false. A project window's close/kill
    // only reaps WINDOW-owned PTYs, so closing a window never terminates a
    // deliberately-headless background agent. Audit High.
    everWindowOwned: !!webContents,
    // Reuse the SAME Set object so subscribe/unsubscribe closures captured
    // against the old entry still target the live set after a respawn.
    subscribers: prevSubs || new Set(),
    outputBuffer: '',
    // Last known PTY geometry, seeded from the spawn size and updated on every
    // resize, so a respawn can restore the tab's real dimensions.
    cols: spawnCols,
    rows: spawnRows,
    // The account bindings this shell launched with. A respawn under the same
    // id re-records them; tear-off and claim keep them, because the PTY and its
    // environment are unchanged by either.
    accountBinding,
    // Taken just before pty.spawn: on Windows the table's row for the shell
    // pid must have started no earlier, or the pid belongs to an older process.
    spawnedAt,
    cwd: safeCwd,
    // Track the requested project path (pre-fallback) for exact-match lookup
    // in getTerminalsForProject. Carson's audit #2 (CRITICAL): the old
    // id-string-prefix lookup collided on sibling projects whose paths
    // shared a prefix (e.g. /x/app vs /x/app-v2 — closing one's window
    // would kill the other's live PTYs).
    projectPath: (cwd && typeof cwd === 'string') ? cwd : null,
  });
  return { pid: term.pid };
}

/**
 * Subscribe a sink to a terminal's output. The sink is { onData, onExit }.
 * Returns { ok, unsubscribe, buffer }. `ok` is false when the terminal does not
 * exist (already exited), so the caller can tell the client instead of
 * pretending the attach succeeded. The buffer is recent output for replay so a
 * freshly-attached client (e.g. a phone) doesn't see a blank screen.
 */
export function subscribeTerminal(id, sink) {
  const entry = terminals.get(id);
  if (!entry || !sink) return { ok: false, unsubscribe: () => {}, buffer: '' };
  entry.subscribers.add(sink);
  return {
    ok: true,
    unsubscribe: () => { entry.subscribers.delete(sink); },
    buffer: entry.outputBuffer,
  };
}

/**
 * List live terminals with their id, shell pid, and starting cwd.
 */
export function listTerminals() {
  return Array.from(terminals.entries()).map(([id, entry]) => ({
    id,
    pid: entry.pty.pid,
    cwd: entry.cwd,
    // Non-secret account metadata only: the configured directories, never an
    // API key or the spawn environment. Lets the app show which account a tab
    // is on and group tabs by profile without recomputing (which would mutate).
    claudeConfigDir: entry.accountBinding?.claudeConfigDir ?? null,
    codexHome: entry.accountBinding?.codexHome ?? null,
  }));
}

/**
 * Write data to a terminal's stdin.
 */
export function writeTerminal(id, data) {
  const entry = terminals.get(id);
  if (entry) {
    // The terminal's own replies (focus in/out, cursor position, device
    // attributes, OSC answers) are not someone typing: they must not mark a
    // prompt on screen stale, or a click into the Chat pane would.
    if (!isTerminalReply(data)) {
      entry.inputSeq = (entry.inputSeq || 0) + 1; // see terminalInputSeq
      entry.outputSeqAtInput = entry.outputSeq || 0;
      entry.inputAt = Date.now();
    }
    for (const fn of inputObservers) {
      try { fn(id, data); } catch { /* an observer must never break typing */ }
    }
    entry.pty.write(data);
  }
}

// How many writes this tab's terminal has received, from every source. The
// Chat view stamps a selector read with it so an answer is refused once
// anything else has typed into the tab since.
export function terminalInputSeq(id) {
  return terminals.get(id)?.inputSeq || 0;
}

// Milliseconds since this tab last received input (Infinity if never). A key
// the program ignored draws nothing, so "settled since input" alone would
// wait forever; the Chat view's selector read also accepts a long quiet.
export function terminalInputAgeMs(id) {
  const at = terminals.get(id)?.inputAt;
  return at ? Date.now() - at : Infinity;
}

/**
 * Count of output chunks that may draw, escape-only ones included. A clear-screen plus
 * cursor moves can replace one prompt with another without a printable byte,
 * so a selector answer is only safe while this has not moved since the read.
 * A chunk that is nothing but OSC strings (title, tab-status markers) cannot
 * draw a cell and is not counted.
 */
export function terminalRawOutputSeq(id) {
  return terminals.get(id)?.rawOutputSeq || 0;
}

/** The tab is being closed (gracefulCloseTerminals): nothing more is typed into it. */
export function terminalClosing(id) {
  return !!terminals.get(id)?.closing;
}

// True once the tab has produced output since its last write. Until then the
// screen may still show what was there BEFORE that input (a prompt already
// answered, not yet repainted), so a selector read from it is not trusted.
export function terminalSettledSinceInput(id) {
  const e = terminals.get(id);
  return !!e && (!e.inputSeq || (e.outputSeq || 0) > (e.outputSeqAtInput || 0));
}

/**
 * Resize a terminal.
 */
export function resizeTerminal(id, cols, rows) {
  const entry = terminals.get(id);
  if (entry) {
    try {
      entry.pty.resize(cols, rows);
      // Remember the geometry so a later respawn restores it (reviewer P2).
      if (Number.isInteger(cols) && cols > 0) entry.cols = cols;
      if (Number.isInteger(rows) && rows > 0) entry.rows = rows;
    } catch (err) {
      console.error(`[terminal-manager] resize error for ${id}:`, err.message);
    }
  }
}

/**
 * Whether a desktop window is currently driving this terminal (vs phone-only).
 * Used by the mobile bridge to avoid resizing a PTY out from under a desktop
 * xterm — when a phone at 60x24 reshapes a PTY that the desktop has at 200x50,
 * TUI apps re-render to the phone's geometry and the desktop display turns to
 * garbage. Lets the mobile path treat its resize as advisory in that case.
 */
export function terminalHasDesktopAttached(id) {
  const entry = terminals.get(id);
  if (!entry) return false;
  return !!(entry.webContents && !entry.webContents.isDestroyed());
}

/**
 * Check if a terminal has a busy child process (not just the shell).
 * Returns the process name if busy, or null if idle.
 */
export async function getTerminalProcess(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  if (IS_WIN) {
    const rows = await winRowsFor(entry, { fresh: true });
    if (!rows) return 'unknown'; // a caller about to type must treat this as busy
    const prog = descendants(rows, entry.pty.pid).find((r) => !['conhost', 'openconsole'].includes(winExeBase(r.name)));
    return prog ? (winExeBase(prog.name) || 'unknown') : null;
  }
  try {
    const pid = entry.pty.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    const { stdout } = await execFileP('/usr/bin/pgrep', ['-lP', String(pid)], {
      timeout: 1000,
      encoding: 'utf8',
    });
    // pgrep -lP returns lines like "12345 claude"
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const name = line.trim().split(/\s+/).slice(1).join(' ');
      if (name && name !== 'zsh' && name !== 'bash' && name !== 'sh') return name;
    }
  } catch {
    // pgrep exits 1 when there are no children: not an answer yet.
  }
  // No program under the shell: the PTY's process may itself be one, when
  // `exec` replaced the shell (a shell function exec'ing claude, `exec cat`).
  try {
    const { stdout } = await execFileP('/bin/ps', ['-o', 'comm=', '-p', String(entry.pty.pid)], {
      timeout: 1000,
      encoding: 'utf8',
    });
    return ptyProgramName(stdout, process.env.SHELL);
  } catch {
    return null;
  }
}

// For the status pollers (terminal:getProcess): every window polls every tab
// it shows (StatusBar every 5s, the tab bar every 10s), and each answer is a
// pgrep plus a ps. With ~45 tabs those piled up behind a busy main thread
// (2026-11-09 stall log: ~15 in flight at once). One answer per tab is shared
// for PROCESS_TTL_MS and concurrent asks share one lookup. Anything about to
// type into a tab must call getTerminalProcess itself, never this.
const PROCESS_TTL_MS = 1500;
const processAnswers = new Map(); // id -> { at, value } | { pending }
export function getTerminalProcessShared(id) {
  // Keyed to the PTY too: a tab id reused for a new shell never gets the old one's answer.
  const ptyPid = terminals.get(id)?.pty?.pid;
  const hit = processAnswers.get(id);
  if (hit && hit.ptyPid === ptyPid) {
    if (hit.pending) return hit.pending;
    if (Date.now() - hit.at < PROCESS_TTL_MS) return Promise.resolve(hit.value);
  }
  const pending = getTerminalProcess(id).then(
    (value) => {
      if (processAnswers.get(id)?.pending === pending) {
        if (terminals.get(id)?.pty?.pid === ptyPid) processAnswers.set(id, { ptyPid, at: Date.now(), value });
        else processAnswers.delete(id);
      }
      return value;
    },
    (err) => { if (processAnswers.get(id)?.pending === pending) processAnswers.delete(id); throw err; },
  );
  processAnswers.set(id, { ptyPid, pending });
  // Bounded by the live tabs: answers for closed tabs go on the next sweep.
  if (processAnswers.size > terminals.size + 64) {
    for (const key of processAnswers.keys()) if (!terminals.has(key) && !processAnswers.get(key)?.pending) processAnswers.delete(key);
  }
  return pending;
}

// Programs that run under an IDLE interactive shell: the shells themselves
// and Powerlevel10k's prompt helper, which lives under every p10k zsh.
const IDLE_SHELL_PROCS = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh)$|^gitstatusd/;

/**
 * Whether anything but an idle shell runs in a tab, for a caller about to type
 * into it unasked (auto-resume): the PTY's own process or anything under it,
 * however deep (a shell wrapper running ssh). null when idle; the program's
 * name when busy; 'unknown' when it could not be told, which a caller must
 * treat as busy (Codex, restore round 9).
 */
export async function terminalBusy(id) {
  const root = terminals.get(id)?.pty?.pid;
  if (typeof root !== 'number' || root <= 0) return 'unknown';
  if (IS_WIN) {
    const rows = await winRowsFor(terminals.get(id), { fresh: true });
    if (!rows) return 'unknown';
    // Anything under the shell but a console host is busy, a nested cmd or
    // PowerShell included: a typed resume does not belong in either.
    const busy = descendants(rows, root).find((r) => !['conhost', 'openconsole'].includes(winExeBase(r.name)));
    return busy ? (winExeBase(busy.name) || 'unknown') : null;
  }
  let stdout;
  try {
    ({ stdout } = await execFileP('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 2000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    console.warn(`[terminal-manager] busy check failed for ${id}:`, err?.message || err);
    return 'unknown';
  }
  const kids = new Map();
  const name = new Map();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    name.set(pid, path.basename(m[3].trim()));
    if (!kids.has(Number(m[2]))) kids.set(Number(m[2]), []);
    kids.get(Number(m[2])).push(pid);
  }
  if (!name.has(root)) return 'unknown';
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const n = name.get(pid) || '';
    if (!IDLE_SHELL_PROCS.test(n)) return n || 'unknown';
    for (const k of kids.get(pid) || []) queue.push(k);
  }
  return null;
}

/**
 * If a terminal is running `claude --resume <id>` (or `-r <id>`), return that
 * session id. Used to link a session to its tab even when the resume was
 * typed manually rather than launched through the app. Returns null otherwise.
 */
export async function getTerminalProcessArgv(id) {
  const info = await getTerminalClaudeInfo(id);
  return info?.sessionId || null;
}

/**
 * Inspect the claude process (if any) running inside a terminal.
 * Returns { sessionId, startedAt } where:
 *   - sessionId: the id from `--resume <id>` / `-r <id>`, else null
 *   - startedAt: epoch ms the claude child process started, else null
 *
 * v1.0.39 (Brett-reported: "each tab isn't saying its name in the session
 * history"): a FRESH `claude` generates its session id at runtime, so the
 * argv contains no id and the old regex-only linker never linked it. Those
 * tabs got no name badge in the sidebar, and auto-resume could never restore
 * them either. startedAt lets the caller correlate the process to the
 * transcript it created (see resolveFreshSessionId in main.js).
 * `unique: true` answers null when more than one claude runs in the shell.
 * soleChild: this is the shell's only child, so no other program in the tab
 * (a suspended claude, say) can be the one the person is really working in.
 */
/**
 * Whether Claude runs anywhere in a tab: the PTY's own process (started with
 * `exec claude`) or any process under it (a child of the shell, or deeper,
 * from a nested `bash`: Codex, rounds 11 and 12). One ps of the whole table.
 */
export async function terminalRunsClaude(id, { skipStopped = false } = {}) {
  const root = terminals.get(id)?.pty?.pid;
  if (typeof root !== 'number' || root <= 0) return false;
  if (IS_WIN) {
    const rows = await winRowsFor(terminals.get(id), { fresh: true });
    if (!rows) return true; // unknown: keep the wait rather than end it on a guess
    return descendants(rows, root).some((r) => winClaudeCommand(r.command));
  }
  let stdout;
  try {
    ({ stdout } = await execFileP('/bin/ps', ['-axo', skipStopped ? 'pid=,ppid=,stat=,command=' : 'pid=,ppid=,command='], { timeout: 2000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    console.warn('[terminal] claude check failed:', err?.message || err);
    return true; // unknown: keep the wait rather than end it on a guess
  }
  // skipStopped: a suspended claude (Ctrl+Z) is not the program on screen (dobius-send into that shell, Codex round 4).
  if (skipStopped) stdout = stdout.split('\n').filter((l) => !/^\s*\d+\s+\d+\s+T/.test(l)).map((l) => l.replace(/^(\s*\d+\s+\d+\s+)\S+\s+/, '$1')).join('\n');
  return claudeInTree(stdout, root);
}

/** Whether `ps -axo pid=,ppid=,command=` output shows Claude at `root` or
 * anywhere under it. */
export function claudeInTree(psText, root) {
  const kids = new Map();
  const cmd = new Map();
  for (const line of String(psText).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    cmd.set(pid, m[3]);
    if (!kids.has(Number(m[2]))) kids.set(Number(m[2]), []);
    kids.get(Number(m[2])).push(pid);
  }
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (cmd.has(pid) && isClaudeCommand(cmd.get(pid))) return true;
    for (const k of kids.get(pid) || []) queue.push(k);
  }
  return false;
}

// `strict`: a process check that failed (a timeout, ps erroring) throws instead of reading as "no claude here"; pgrep's
// own exit 1 (no children at all) is still null.
// The tab's shell replaced by Claude itself (`exec claude ...`). strict: unknown (throws) when it may be Claude; any
// other mode reads that as none.
// ponytail: the cheap gate is node-pty's foreground program name (a tty read, no process spawned), so no `ps` runs for
// the many tabs sitting at a prompt. Polled lookups only: an exec'd Claude whose foreground child is a shell also reads
// as a shell, so the resume gate and strict lookups pass no entry and always look.
const SHELL_NAME = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|login)$/;
async function ptySelf(pid, strict, entry) {
  let fg = null;
  try { fg = entry?.pty?.process; } catch { fg = null; }
  if (typeof fg === 'string' && SHELL_NAME.test(fg.split('/').pop())) return null;
  try { return await ptySelfClaude(pid); }
  catch (err) { if (strict) throw err; return null; }
}
async function ptySelfClaude(pid) {
  const { stdout } = await execFileP('/bin/ps', ['-o', 'lstart=,command=', '-p', String(pid)], { timeout: 1000, encoding: 'utf8' });
  const line = stdout.trim();
  if (!line) return null;
  const command = line.slice(24).trim();
  if (!isClaudeCommand(command)) {
    if (/claude/i.test(command)) throw new Error('a program there names claude');
    return null;
  }
  const kind = command.length > 4096 ? 'maybe' : classifyClaudeProcess(command).kind;
  if (kind === 'maybe') throw new Error('a program there may be Claude');
  if (kind !== 'claude') return null;
  const parsed = Date.parse(line.slice(0, 24));
  const m = command.match(/(?:--resume|-r)\s+([a-zA-Z0-9][\w-]{1,99})/);
  return { sessionId: m ? m[1] : null, startedAt: Number.isFinite(parsed) ? parsed : null, pid, soleChild: true, ptySelf: true };
}

// The PTY's own process when it is Claude (`exec claude`), whatever its children are; null otherwise or unknown.
async function ptySelfOf(id) {
  const entry = terminals.get(id);
  const pid = entry?.pty?.pid;
  if (typeof pid !== 'number' || pid <= 0) return null;
  return ptySelf(pid, false, null); // on demand (the resume gate): always looked at
}

// thorough: an on-demand caller (snooze): the PTY's own process is always looked at, as for strict.
export async function getTerminalClaudeInfo(id, { unique = false, strict = false, thorough = false } = {}) {
  const entry = terminals.get(id);
  if (!entry) return null;
  if (IS_WIN) return winClaudeInfo(entry, unique, strict);
  try {
    const pid = entry.pty.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    let pgrepOut;
    try {
      ({ stdout: pgrepOut } = await execFileP('/usr/bin/pgrep', ['-P', String(pid)], { timeout: 1000, encoding: 'utf8' }));
    } catch (err) {
      // No children at all (pgrep's exit 1): the PTY's own process may be Claude (`exec claude --resume X`).
      if (err?.code !== 1) throw err;
      return await ptySelf(pid, strict, strict || thorough ? null : entry);
    }
    const children = pgrepOut.trim().split('\n').filter(Boolean);
    // `unique`: one ps per child, so a shell with many children is not
    // walked (each poll would spawn them all again): no answer.
    if ((unique || strict) && children.length > MAX_UNIQUE_CHILDREN) {
      if (strict) throw new Error('too many programs in that shell to check');
      return null;
    }
    let found = null;
    for (const childPid of children) {
      // `lstart` is the process start time; `command` is the argv. One ps
      // call gets both so the fresh-session correlation costs nothing extra.
      const { stdout: psOut } = await execFileP('/bin/ps', ['-o', 'lstart=,command=', '-p', childPid], {
        timeout: 1000,
        encoding: 'utf8',
      });
      const line = psOut.trim();
      if (!line) continue;
      // `lstart` is a fixed 24-char date ("Wed Jul 15 21:49:26 2026"), the
      // rest is the command.
      const lstart = line.slice(0, 24);
      const command = line.slice(24).trim();
      if (!isClaudeCommand(command)) {
        // `unique`: anything else that so much as names claude (a path with
        // spaces such as `/x/CLI Tools/claude[/versions/N]` fails
        // isClaudeCommand) may be one, so the shell is ambiguous. Fails
        // closed: a child like `vim claude.md` also costs the Waiting label.
        if (unique && /claude/i.test(command)) return null;
        // strict: may be one (a path with spaces), so that tab's session is not known.
        if (strict && /claude/i.test(command)) throw new Error('a program there names claude');
        continue;
      }
      // `unique`: the strict reading too, so a process that only names the CLI
      // (`node watcher.js /path/claude`) is not taken for it. Capped, since
      // classifyClaudeProcess's cost grows with the square of the length and
      // a claude command line is short.
      if (unique && (command.length > 4096 || classifyClaudeProcess(command).kind !== 'claude')) return null;
      // strict: the same reading. A process that only names the CLI (`node watcher.js /path/claude --resume X`) is not
      // Claude; one that might be is unknown.
      if (strict) {
        const kind = command.length > 4096 ? 'maybe' : classifyClaudeProcess(command).kind;
        if (kind === 'maybe') throw new Error('a program there may be Claude');
        if (kind !== 'claude') continue;
      }
      const parsed = Date.parse(lstart);
      const startedAt = Number.isFinite(parsed) ? parsed : null;
      const m = command.match(/(?:--resume|-r)\s+([a-zA-Z0-9][\w-]{1,99})/);
      const info = { sessionId: m ? m[1] : null, startedAt, pid: Number(childPid), soleChild: children.length === 1 };
      if (!unique && !strict) return info;
      // `unique`: two claudes in one shell cannot be told apart, so no answer. `strict`: that is not known (throws).
      if (found) {
        if (strict) throw new Error('two Claude processes in that shell');
        return null;
      }
      found = info;
    }
    // None of the children is Claude, but the PTY's own process may be (`exec claude`, with an MCP server or other
    // helper as its child). Every mode: the resume gate must see it too.
    if (!found) return await ptySelf(pid, strict, strict || thorough ? null : entry);
    // strict: the PTY's own process may be a second Claude (`exec claude` running `claude -p`), which is not known.
    if (strict && await ptySelf(pid, true, null)) throw new Error('two Claude processes in that tab');
    return found;
  } catch (err) {
    if (strict && !(err?.code === 1 && String(err?.cmd || '').startsWith('/usr/bin/pgrep'))) throw err;
    return null;
  }
}

/**
 * The interactive Codex running in a terminal, for Speak: a direct child of
 * the tab's shell, or the PTY's own process when `exec codex` replaced the
 * shell. { pid, startedAt, sessionId (from `codex resume <uuid>`, else null),
 * cwd (the folder Codex works in: `--cd` when given) }, or null when no Codex
 * TUI runs there. A headless `codex exec` is not one.
 * ponytail: a codex under a wrapper (`bash -c 'codex; ...'`) is a grandchild
 * and is not looked for.
 */
export async function getTerminalCodexInfo(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  const pid = entry.pty.pid;
  if (typeof pid !== 'number' || pid <= 0) return null;
  if (IS_WIN) {
    const rows = await winRowsFor(entry);
    if (!rows) return null;
    for (const r of shellPrograms(rows, pid).slice(0, MAX_UNIQUE_CHILDREN)) {
      const parsed = winCodexCommand(r.command, parseCodexCommand);
      if (!parsed) continue;
      // ponytail: Windows has no cheap read of another process's cwd, so a
      // Codex is taken to work in the tab's folder (or its --cd).
      const base = entry.cwd || null;
      const cwd = parsed.cd ? (path.isAbsolute(parsed.cd) ? path.resolve(parsed.cd) : (base ? path.resolve(base, parsed.cd) : null)) : base;
      return { pid: r.pid, startedAt: r.startedAt, sessionId: parsed.sessionId, cwd };
    }
    return null;
  }
  let pids = [];
  try {
    const { stdout } = await execFileP('/usr/bin/pgrep', ['-P', String(pid)], { timeout: 1000, encoding: 'utf8' });
    pids = stdout.trim().split('\n').filter(Boolean).slice(0, MAX_UNIQUE_CHILDREN);
  } catch {
    // pgrep exits 1 when the shell has no children.
  }
  pids.push(String(pid));
  for (const p of pids) {
    let line;
    try {
      ({ stdout: line } = await execFileP('/bin/ps', ['-o', 'lstart=,command=', '-p', p], { timeout: 1000, encoding: 'utf8' }));
    } catch { continue; } // exited between pgrep and ps
    line = line.trim();
    const parsed = line ? parseCodexCommand(line.slice(24)) : null;
    if (!parsed) continue;
    const startedAt = Date.parse(line.slice(0, 24));
    const procCwd = await getProcessCwd(Number(p));
    let cwd = procCwd;
    if (parsed.cd) cwd = parsed.cd.startsWith('/') ? path.resolve(parsed.cd) : (procCwd ? path.resolve(procCwd, parsed.cd) : null);
    return { pid: Number(p), startedAt: Number.isFinite(startedAt) ? startedAt : null, sessionId: parsed.sessionId, cwd };
  }
  return null;
}

/**
 * Session ids that a LIVE terminal is running Claude on right now.
 *
 * Callers that reason about "abandoned" or "resumable" work need this, and
 * data-service cannot see the terminal manager. Being wrong costs real work in
 * both directions: name a session that is not running and offering Resume
 * double-runs one transcript under two processes; miss one that is, and
 * genuinely abandoned work is suppressed and never resurfaces.
 *
 * The truth is the PROCESS, in two parts:
 *   - argv `--resume <id>` names the session directly. Authoritative.
 *   - a FRESH claude generates its id at runtime, so its argv has no id at
 *     all. Only the saved sessionId -> tabId map can name that one.
 *
 * The map is a cache and it lies in ways that matter (Codex, High):
 *   - the tab may be gone entirely, so require it to be live
 *   - claude may have EXITED inside a tab that is still open, which is exactly
 *     the abandoned case the feature exists to surface, so require a running
 *     claude in that tab
 *   - the tab may have moved on to a different session, and the link stays
 *     stale until the 15s reconcile tick. If argv names an id, argv wins and
 *     the map has nothing to add for that tab
 *   - several old links can point at one tab, and at most one can be current,
 *     so take only the most recently captured
 * Best effort: never throws.
 */
async function processSessionIds() {
  const ids = new Set();
  try {
    const terms = listTerminals();
    const infoByTab = new Map();
    await Promise.all(terms.map(async (t) => {
      try { infoByTab.set(t.id, await getTerminalClaudeInfo(t.id)); }
      catch { infoByTab.set(t.id, null); }
      // Claude's own record moves with /clear while argv keeps the old id: both are live (the snooze, History and the
      // board read the record), so both are refused a second resume.
      // The PTY's own Claude too (`exec claude` with a Claude child is seen above only through the child).
      let self = null;
      try { self = await ptySelfOf(t.id); } catch { self = null; }
      if (self?.sessionId) ids.add(self.sessionId);
      for (const info of [infoByTab.get(t.id), self]) {
        if (!info) continue;
        try { const sid = await presenceSessionId(info, t.claudeConfigDir ?? null); if (sid) ids.add(sid); }
        catch { /* best effort */ }
      }
    }));

    // Tabs running a claude whose session id we CANNOT read from argv. These
    // are the only tabs the saved map can tell us anything useful about, and
    // the process start time is what decides whether a link is current.
    const freshTabs = new Map(); // tabId -> claude startedAt (may be null)
    for (const [tabId, info] of infoByTab) {
      if (info && !info.sessionId) freshTabs.set(tabId, info.startedAt);
      if (info?.sessionId) ids.add(info.sessionId);
    }

    if (freshTabs.size > 0) {
      const newestPerTab = new Map(); // tabId -> { sid, capturedAt }
      for (const [sid, link] of Object.entries(getSessionTabMap() || {})) {
        if (!link?.tabId || !freshTabs.has(link.tabId)) continue;
        const at = typeof link.capturedAt === 'number' ? link.capturedAt : 0;
        // The link must postdate the claude process it claims to describe.
        // Stop `old`, start a bare `claude` in the SAME tab, and for up to 15s
        // (until the next capture tick) the link still names `old` while the
        // tab is running something else entirely, which hid `old` from loose
        // ends even though it was genuinely abandoned. Codex High, round 3.
        //
        // STRICTLY after, plus a second. `ps lstart` truncates DOWN to the
        // second, so startedAt is already up to 999ms EARLIER than the real
        // start; slack in that direction lets the stale link back through
        // (Codex High, round 4). Being strict costs nothing real: the capture
        // tick is 15s, so a genuine link is never written within a second of
        // the process starting, and the worst case is a live fresh session not
        // being excluded, which findLooseEnds drops anyway on its 45-minute
        // idle rule.
        const startedAt = freshTabs.get(link.tabId);
        if (Number.isFinite(startedAt) && at < startedAt + 1000) continue;
        const best = newestPerTab.get(link.tabId);
        if (!best || at > best.capturedAt) newestPerTab.set(link.tabId, { sid, capturedAt: at });
      }
      for (const { sid } of newestPerTab.values()) ids.add(sid);
    }
  } catch { /* best effort */ }
  return ids;
}

/**
 * Everything that must not be resumed again right now: sessions a real process
 * is on, PLUS sessions somebody has claimed and is about to start.
 */
export async function liveClaudeSessionIds() {
  const ids = await processSessionIds();
  for (const sid of activeReservations()) ids.add(sid);
  return [...ids];
}

// A resume is not visible in the process table for a second or two: the shell
// has to print a prompt, the command has to be typed in, and claude has to
// start. Two surfaces checking "is it live" inside that window both got `no`
// and both resumed, which is the double-run this is all meant to prevent
// (Codex Critical, round 3). A claim reserves the id for that window.
const resumeReservations = new Map(); // sessionId -> { tabId, expiry }
// Un-tabbed reservations are placeholders held for the moment between "the
// user clicked resume" and "we know which tab it landed in", so they expire
// fast. A tab-bound one has to outlive the whole startup path: shell profile,
// then claude itself. A fixed 30s was NOT enough (a slow .zshrc alone can eat
// it), and letting it lapse early re-opens the double-run. Codex Critical,
// round 4. The tab check below is what actually ends these; the timeout is
// only a backstop for a tab that lives forever after a failed resume.
const RESERVATION_MS = 30_000;
const TAB_RESERVATION_MS = 600_000;
/**
 * Should this reservation be forgotten? Pure, so every branch is testable
 * without waiting out real timeouts.
 *
 * Deliberately does NOT try to detect a FAILED resume by looking for a claude
 * process after a grace period. That was tried and it re-opened the very
 * double-run this exists to prevent (Codex Critical, round 6): a shell profile
 * slower than the grace looks identical to a resume that failed, so the
 * reservation was dropped while the resume was still legitimately on its way,
 * and a second surface was cleared to run the same transcript. No timeout can
 * separate "slow" from "failed"; only the process appearing can, and waiting
 * for that IS the window. So the rule stays on facts: the tab is alive, or it
 * is not. Retrying a failed resume is handled by ownership in
 * claimSessionResume instead, which needs no timing guess at all.
 *
 * @param r {{tabId: string|null, reservedAt: number, expiry: number}}
 * @param ctx {{now: number, tabLive: boolean}}
 */
export function shouldDropReservation(r, { now, tabLive }) {
  if (!r || r.expiry <= now) return true;
  if (!r.tabId) return false;   // placeholder, rides its short expiry
  return !tabLive;              // the resume died with its tab
}

function activeReservations() {
  const now = Date.now();
  let live = null;
  for (const [sid, r] of resumeReservations) {
    if (r.tabId && !live) live = new Set(listTerminals().map((t) => t.id));
    if (shouldDropReservation(r, { now, tabLive: !r.tabId || live.has(r.tabId) })) {
      resumeReservations.delete(sid);
    }
  }
  return resumeReservations.keys();
}

/**
 * Take the slot. INTERNAL: an unconditional reserve is a footgun, because it
 * silently overwrites somebody else's legitimate claim (auto-resume did
 * exactly that to a resume the phone had already started, and both ran.
 * Codex Critical, round 9). Everything outside this module goes through
 * claimSessionResume, which can refuse.
 */
function reserve(sessionId, tabId = null) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const bound = typeof tabId === 'string' && tabId ? tabId : null;
  const now = Date.now();
  resumeReservations.set(sessionId, {
    tabId: bound,
    reservedAt: now,
    expiry: now + (bound ? TAB_RESERVATION_MS : RESERVATION_MS),
  });
}

/**
 * Give back a reservation YOU hold, for a resume that was claimed and then
 * abandoned (a spawn that threw, a queued auto-resume that got cancelled).
 *
 * Ownership-checked, exactly like the claim. Releasing by session id alone was
 * a footgun in the same shape as the unconditional reserve: a stale
 * auto-resume timer, giving up on a session the PHONE had since claimed,
 * deleted the phone's reservation and re-opened the double-run window while
 * the phone's own `claude --resume` was still on its way (Codex Critical,
 * round 10). Pass the tab you claimed with; pass nothing only to release a
 * placeholder that never got a tab.
 *
 * @returns true if a reservation was actually released.
 */
export function releaseSessionResume(sessionId, tabId = null) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const held = resumeReservations.get(sessionId);
  if (!held) return false;
  if ((held.tabId || null) !== (tabId || null)) return false; // not yours
  resumeReservations.delete(sessionId);
  return true;
}

/**
 * Ask permission to resume, and take the slot in the same step.
 * Check-then-act split across two calls is exactly what let two surfaces
 * through, so this is one call: it returns false when the session is already
 * running or already claimed, and otherwise reserves it before returning true.
 * Single-threaded main process, so this is atomic by construction.
 */
export async function claimSessionResume(sessionId, tabId = null) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  // A real process on this session beats everything, including ownership: if
  // claude is genuinely running it, nobody may start a second one, not even
  // the tab that reserved it.
  if ((await processSessionIds()).has(sessionId)) return false;
  // Prune FIRST, then read: everything from here down is synchronous, so a
  // concurrent claim that is still inside the await above cannot interleave,
  // and whichever caller reaches this line first takes the slot.
  activeReservations();
  const held = resumeReservations.get(sessionId);
  if (held) {
    // Retrying in the tab that already owns this session is always allowed.
    // Without this, a resume that failed outright (claude not on PATH, the CLI
    // exiting at once) would hold the session until its tab closed, refusing
    // the obvious retry. Ownership answers that without any timing guess, and
    // it still refuses a DIFFERENT tab, which is the case that corrupts a
    // transcript. Codex round 5 Medium, round 6 Critical.
    if (!tabId || held?.tabId !== tabId) return false;
  }
  reserve(sessionId, tabId);
  return true;
}

/**
 * Attach a tab to a reservation you ALREADY hold, once you know which tab the
 * resume landed in. A no-op when no reservation exists, so it can never take a
 * session, and it refuses to move one that belongs to a different tab.
 */
export function bindReservationTab(sessionId, tabId) {
  const held = resumeReservations.get(sessionId);
  if (!held || !tabId) return false;
  if (held.tabId && held.tabId !== tabId) return false;
  reserve(sessionId, tabId);
  return true;
}

/**
 * Get the current working directory of a terminal's shell process.
 * Uses `lsof` to query the shell PID's cwd descriptor. Returns null if the
 * terminal doesn't exist or lsof can't determine the cwd.
 */
export async function getTerminalCwd(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  // ponytail: on Windows the shell's live folder cannot be read from outside
  // it, so this is the folder the tab started in. A Claude running in the tab
  // reports its own folder through its session record (getProcessCwd).
  if (IS_WIN) return entry.cwd || null;
  return getProcessCwd(entry.pty.pid);
}

/**
 * Working directory of one process (the shell, or a claude running under it:
 * `(cd wt && exec claude)` leaves the shell elsewhere).
 */
export async function getProcessCwd(pid, startFt = null) {
  if (IS_WIN) return winProcessCwd(pid, startFt);
  try {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    // -Fn prints a "p<pid>" line then an "n<cwd>" line. Parse the n-prefixed one.
    const { stdout } = await execFileP('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      timeout: 1500,
      encoding: 'utf8',
    });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.length > 1) return line.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Kill a specific terminal.
 */
export function killTerminal(id, { respawn = false } = {}) {
  const entry = terminals.get(id);
  if (entry) {
    try {
      // Behaviour-neutral (the onExit handler's identity guard already no-ops
      // once the entry is gone) but it frees the ThreadSafeFunction now instead
      // of leaving a late callback that could land during a quit.
      disposeListeners(entry);
      entry.pty.kill();
    } catch (err) {
      console.error(`[terminal-manager] kill error for ${id}:`, err.message);
    }
    terminals.delete(id);
    // A kill skips onExit (its identity guard sees the entry gone), so
    // observers that care that a shell went away hear it here.
    for (const obs of terminalObservers) {
      try { obs.onKill?.(id, { respawn }); } catch (err) { console.warn('[terminal-manager] kill observer:', err?.message || err); }
    }
  }
}

/**
 * Gracefully close specific terminals by sending Ctrl+C twice (ends Claude
 * sessions cleanly so they can be resumed), then wait for output.
 * @param {string[]} [ids] — terminal IDs to close. If omitted, closes all.
 * @returns {Promise<void>}
 */
export async function gracefulCloseTerminals(ids) {
  const entries = ids
    ? ids.map((id) => terminals.get(id)).filter(Boolean)
    : Array.from(terminals.values());
  if (entries.length === 0) return;
  // Closing: queued Chat submits must not paste or press Enter from here on
  // (terminalClosing), and the Ctrl+C below counts as input like any other.
  for (const entry of entries) { entry.closing = true; entry.inputSeq = (entry.inputSeq || 0) + 1; }
  // First Ctrl+C — interrupts any running command
  for (const entry of entries) {
    try { entry.pty.write('\x03'); } catch { void 0; }
  }
  await new Promise((r) => setTimeout(r, 500));
  // Second Ctrl+C — triggers Claude to print resume session ID
  for (const entry of entries) {
    try { entry.pty.write('\x03'); } catch { void 0; }
  }
  // Give Claude time to print the resume ID before terminals get killed
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * Gracefully close all terminals — called on app quit.
 * @returns {Promise<void>}
 */
export async function gracefulCloseAll() {
  return gracefulCloseTerminals();
}

/**
 * Get terminal IDs belonging to a project, matched on the stored projectPath
 * by exact equality (not an id string-prefix, which collides for sibling
 * projects whose paths share a prefix — e.g. /x/app vs /x/app-v2).
 * Carson's audit #2 (CRITICAL).
 * @param {string} projectPath
 * @returns {string[]}
 */
export function getTerminalsForProject(projectPath) {
  const target = (projectPath && typeof projectPath === 'string') ? projectPath : null;
  const matching = [];
  for (const [id, entry] of terminals) {
    if (entry.projectPath === target) {
      matching.push(id);
    }
  }
  return matching;
}

/**
 * Kill all terminals — called on app quit.
 */
/**
 * Detach a PTY's JS callbacks. MUST run before kill() on any shutdown path:
 * kill() is asynchronous, so node-pty's final data/exit callbacks arrive later,
 * and if that is after Node starts tearing down its environment the NAPI throw
 * aborts the process. Safe to call twice.
 */
function disposeListeners(entry) {
  for (const d of (entry?.disposables || [])) {
    try { d?.dispose?.(); } catch { /* already disposed */ }
  }
  if (entry) entry.disposables = [];
}

export function killAll() {
  for (const [id, entry] of terminals) {
    try {
      // Unregister FIRST, then kill: the reverse order is what crashed the
      // app on the update-Restart path (SIGABRT in CleanupHandles).
      disposeListeners(entry);
      entry.pty.kill();
    } catch (err) {
      console.error(`[terminal-manager] killAll error for ${id}:`, err.message);
    }
  }
  terminals.clear();
}

/**
 * Reassign a terminal's output to a different BrowserWindow's webContents.
 * Used for tab tear-off: the PTY stays alive but sends data to the new window.
 * @param {string} id — terminal ID
 * @param {Electron.WebContents} newWebContents — the new window's webContents
 * @returns {boolean} true if reassigned, false if terminal not found
 */
export function reassignTerminal(id, newWebContents) {
  const entry = terminals.get(id);
  if (!entry) return false;
  entry.webContents = newWebContents;
  if (newWebContents) entry.everWindowOwned = true; // a window claim binds it. Audit High.
  // Replay the last `dobius-tab` label to the claiming window: one that landed
  // while a tear-off window was still loading went to the source tab, which is
  // removed after the handoff (Codex round 4). The renderer's precedence rules
  // make a repeat a no-op.
  if (entry.lastAgentLabel && newWebContents && !newWebContents.isDestroyed()) {
    newWebContents.send('terminal:autoLabel', id, entry.lastAgentLabel);
  }
  return true;
}

/**
 * True if this terminal was ever bound to a desktop window. False for headless
 * (voice-conductor background agents) and phone-spawned PTYs, which a window's
 * close must never Ctrl+C or kill. Audit High.
 */
export function wasWindowOwned(id) {
  return !!terminals.get(id)?.everWindowOwned;
}

/**
 * The webContents.id that currently owns a terminal's output (the last window to
 * create or claim it), or null if the terminal or its owner is gone. Lets a
 * closing window kill a PTY ONLY when it is the real owner, so an aborted /
 * never-claimed tear-off window closing can't kill a PTY still bound to the
 * source window. Codex.
 */
/**
 * Windows: the usual tool folders that exist but are missing from PATH, appended after it (never ahead of what the
 * person set up). Claude Code's installer may not add %USERPROFILE%\.local\bin (Max's README, 2026-11-07), so
 * `claude` was not found in a new tab; npm's global folder holds gws and codex. Pure apart from the existence check.
 */
export function windowsToolDirs(currentPath, env = process.env, exists = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) {
  const have = new Set(String(currentPath || '').split(';').map((d) => d.replace(/[\\/]+$/, '').toLowerCase()).filter(Boolean));
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    env.USERPROFILE && path.win32.join(env.USERPROFILE, '.local', 'bin'),
    env.APPDATA && path.win32.join(env.APPDATA, 'npm'),
    path.win32.join(pf, 'nodejs'),
    path.win32.join(pf, 'Git', 'cmd'),
    path.win32.join(pf, 'Tailscale'),
  ].filter(Boolean);
  return candidates.filter((d) => !have.has(d.toLowerCase()) && exists(d));
}

/** Where per-instance helper commands live. On every tab's PATH. */
export function tabBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

/**
 * Send an IPC message to the window that currently shows terminal `id`
 * (follows tear-off reassignment). Returns 'sent', 'no-terminal' or
 * 'no-window' (a headless PTY, or its window is gone).
 */
export function sendToTerminalWindow(id, channel, ...args) {
  const entry = terminals.get(id);
  if (!entry) return 'no-terminal';
  if (channel === 'terminal:autoLabel') entry.lastAgentLabel = args[0];
  if (!entry.webContents || entry.webContents.isDestroyed()) return 'no-window';
  entry.webContents.send(channel, id, ...args);
  return 'sent';
}

export function getTerminalWebContentsId(id) {
  const entry = terminals.get(id);
  const wc = entry?.webContents;
  if (!wc || wc.isDestroyed?.()) return null;
  return wc.id;
}


/**
 * Get all active terminal IDs.
 */
export function getActiveTerminals() {
  return Array.from(terminals.keys());
}

/**
 * Recent RAW output (ANSI included) for a terminal, or '' if unknown. Used by
 * the mobile selector probe to detect an interactive selection prompt in the
 * live screen. The buffer is a rolling tail (64KB idle / 1MB when subscribed),
 * which is more than a screenful, so a current selector is always within it.
 */
export function getTerminalBuffer(id) {
  const entry = terminals.get(id);
  return entry ? entry.outputBuffer : '';
}

/** The PTY's current width in columns (last spawn or resize), or null. */
export function terminalCols(id) {
  return terminals.get(id)?.cols ?? null;
}

/** The PTY's current height in rows (last spawn or resize), or null. */
export function terminalRows(id) {
  return terminals.get(id)?.rows ?? null;
}

// The live pty object behind a tab id, or null. Identity, not a handle to
// write through: a caller that waits between two writes compares it to tell
// "same shell" from "the tab id now names a respawned PTY".
export function terminalInstance(id) {
  return terminals.get(id)?.pty || null;
}

// ---------------------------------------------------------------------------
// Windows (see win-proc.js). Same answers as the ps/pgrep/lsof paths above.
// ---------------------------------------------------------------------------

// A table that describes THIS entry's shell: it has the shell's pid with a
// creation time no earlier than the spawn (taken just before pty.spawn, on the
// same clock, so no slack: Codex showed a second of it admitted the previous
// owner of a reused pid). A cached table that fails is read again once, fresh;
// still wrong means no answer.
async function winRowsFor(entry, { fresh = false } = {}) {
  const pid = entry?.pty?.pid;
  if (typeof pid !== 'number' || pid <= 0) return null;
  // The first read that finds the shell pins its exact creation time; every
  // later read must show that same process. A pid seen to start after the
  // spawn but long after it is some later process (the shell can exit before
  // node-pty reports it, and Windows can then give its pid away: Codex).
  const ok = (rows) => {
    const root = rows?.find((r) => r.pid === pid);
    if (!root || root.startFt == null || !Number.isFinite(root.startedAt)) return false;
    if (entry.shellStartFt) return sameFiletime(root.startFt, entry.shellStartFt);
    if (!Number.isFinite(entry.spawnedAt) || root.startedAt < entry.spawnedAt || root.startedAt > entry.spawnedAt + 10_000) return false;
    entry.shellStartFt = String(root.startFt);
    return true;
  };
  let rows = await winProcessTable({ fresh });
  if (!ok(rows) && !fresh) rows = await winProcessTable({ fresh: true });
  return ok(rows) ? rows : null;
}

// strict: what cannot be told (no process rows, too many programs, two Claudes, one that only names claude) throws.
async function winClaudeInfo(entry, unique, strict = false) {
  const unknown = (why) => { if (strict) throw new Error(why); return null; };
  const pid = entry.pty.pid;
  if (typeof pid !== 'number' || pid <= 0) return null;
  const rows = await winRowsFor(entry);
  if (!rows) return unknown('process list not read');
  const progs = shellPrograms(rows, pid);
  if ((unique || strict) && progs.length > MAX_UNIQUE_CHILDREN) return unknown('too many programs in that shell to check');
  let found = null;
  for (const r of progs) {
    const c = winClaudeCommand(r.command);
    if (!c) {
      if ((unique || strict) && /claude/i.test(r.command || '')) return unknown('a program there names claude');
      continue;
    }
    const info = {
      sessionId: c.sessionId,
      startedAt: r.startedAt,
      startFt: r.startFt === null ? null : String(r.startFt),
      pid: r.pid,
      soleChild: progs.length === 1,
    };
    if (!unique && !strict) return info;
    if (found) return unknown('two Claude processes in that shell');
    found = info;
  }
  return found;
}

// Claude's own folder, from its session record (<configDir>/sessions/<pid>.json).
// The record must match the very process the caller resolved: its pid AND its
// creation time (startFt), which the caller read together. Without startFt
// there is no proof the pid still names that process, so there is no answer
// (Codex, two rounds: a reused pid, read through a second table query or a
// tab shell's pid, answered with another session's folder). A tab's shell
// folder comes from getTerminalCwd, never from here.
async function winProcessCwd(pid, startFt) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (startFt == null) return null;
  const dirs = new Set([null]);
  for (const entry of terminals.values()) if (entry.accountBinding?.claudeConfigDir) dirs.add(entry.accountBinding.claudeConfigDir);
  for (const dir of dirs) {
    const rec = await readPresenceRecordAt(pid, dir);
    if (rec && rec.pid === pid && sameFiletime(recordStartFiletime(rec), startFt) && typeof rec.cwd === 'string' && path.isAbsolute(rec.cwd)) return rec.cwd;
  }
  return null;
}

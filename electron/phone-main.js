/**
 * Phone mode's dependencies, built from main's own helpers (docs/phone-mode-design.md, "Main: electron/phone-mode.js").
 * main.js passes its functions in; this file decides nothing about runs, it only answers phone-mode.js's questions
 * about tabs, Claude processes, the screen and the account a tab is on. The small rules here are unit tested
 * (electron/__tests__/phone-main.test.mjs); the rest is a direct mapping onto functions the account move already uses.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createPhoneMode } from './phone-mode.js';

/** Phone mode is offered on macOS only (the launch is a zsh or bash script) and only with the setting on. */
export function phoneModeOn(settings, platform = process.platform) {
  return platform === 'darwin' && settings?.phoneMode === true;
}

/**
 * The account pin that restarts a tab on the account it runs on now: `{ id: null }` for the default identity (no
 * CLAUDE_CONFIG_DIR at spawn), `{ id }` for the one Claude account whose profile folder is the tab's, undefined when
 * none or several match (the move is refused rather than moving the conversation to another login).
 */
export function pinForBinding(claudeConfigDir, accounts, envFor) {
  if (claudeConfigDir == null || claudeConfigDir === '') return { id: null };
  const want = path.resolve(String(claudeConfigDir));
  const hits = (Array.isArray(accounts) ? accounts : []).filter((a) => {
    if (a?.type !== 'claude' || typeof a.id !== 'string' || !a.id) return false;
    let dir;
    try { dir = envFor(a)?.CLAUDE_CONFIG_DIR; } catch { return false; }
    return typeof dir === 'string' && path.resolve(dir) === want;
  });
  return hits.length === 1 ? { id: hits[0].id } : undefined;
}

/** macOS's memory pressure level from `sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function pressureLevel(stdout) {
  const n = Number.parseInt(String(stdout ?? '').trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** The session ids the tab's own Claude (a direct child of its shell, never the runner's) shows it is running. */
export function tuiSessionIdsOf(info, rec) {
  const out = [];
  if (typeof rec?.sessionId === 'string' && rec.sessionId) out.push(rec.sessionId);
  if (typeof info?.sessionId === 'string' && info.sessionId && !out.includes(info.sessionId)) out.push(info.sessionId);
  return out;
}

const PRESSURE_TTL_MS = 10_000; // one sysctl per 10 s at most, and only when a move is asked for

/**
 * Build phone mode from main's helpers. `m`:
 *   userData, exe, runnerPath, log, settings(), accounts(), envFor(account)
 *   tabs(), inputSeq(id), inputHeld(id), activity(id), screen(id), promptBox(lines, modes)
 *   claudeInfo(id) (strict, never the PTY's own process), scan(), presence(info, configDir), hasTranscript(sessionId)
 *   processCwd(pid), isDir(p), stop(pid), alive(pid), sleep(ms)
 *   ownerOf(tabId) -> webContents or null, movable(tabId, sender) -> refusal string or null
 *   spawn(tabId, cwd, sender, pin, phone) -> true when the PTY was respawned
 *   notify(tabId, state)
 */
export function createPhoneMain(m) {
  let pressure = { at: 0, level: null };
  const readPressure = () => new Promise((resolve) => {
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 1000, encoding: 'utf8' }, (err, out) => resolve(err ? null : pressureLevel(out)));
  });
  // The Mac's own pressure reading: warning or worse refuses a new move. Read on demand, cached briefly; a failed read
  // is not pressure (the setting is the user's choice and the check is a courtesy, not a guard).
  let pressureRead = null;
  const refreshPressure = () => {
    if (!pressureRead && Date.now() - pressure.at > PRESSURE_TTL_MS) {
      pressureRead = readPressure().then((level) => { pressure = { at: Date.now(), level }; }).finally(() => { pressureRead = null; });
    }
    return pressureRead;
  };

  const presenceFor = async (tabId, info) => {
    const scan = await m.scan().catch(() => null);
    const g = (scan?.groups || []).find((x) => Array.isArray(x.pids) && x.pids.includes(info.pid)) || null;
    const tab = m.tabs().find((t) => t.id === tabId);
    return m.presence(info, g ? (g.envUnset ? null : g.configDir) : tab?.claudeConfigDir ?? null);
  };

  const pm = createPhoneMode({
    userData: m.userData,
    log: m.log,
    exe: m.exe,
    runnerPath: m.runnerPath,
    on: () => phoneModeOn(m.settings()),
    tabs: () => m.tabs(),
    inputSeq: (id) => m.inputSeq(id),
    inputHeld: (id) => m.inputHeld(id),
    activity: (id) => m.activity(id),
    screen: (id) => m.screen(id),
    promptBox: (lines, modes) => m.promptBox(lines, modes),
    claudeInfo: (id) => m.claudeInfo(id),
    presence: (info, tabId) => presenceFor(tabId, info),
    hasTranscript: (sessionId) => m.hasTranscript(sessionId),
    processArgv: (pid) => new Promise((resolve, reject) => {
      execFile('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 1000, encoding: 'utf8' }, (err, out) => {
        if (err) reject(err); else resolve(String(out).trim().split(/\s+/).filter(Boolean));
      });
    }),
    processCwd: (pid) => m.processCwd(pid),
    isDir: (p) => m.isDir(p),
    stop: (pid) => m.stop(pid),
    alive: (pid) => m.alive(pid),
    sleep: (ms) => m.sleep(ms),
    memoryLow: () => { void refreshPressure(); return pressure.level != null && pressure.level >= 2; },
    cannotRestart: (tabId) => {
      const sender = m.ownerOf(tabId);
      if (!sender) return 'that tab has no window on this Mac';
      const why = m.movable(tabId, sender);
      if (why) return why;
      const tab = m.tabs().find((t) => t.id === tabId);
      return pinForBinding(tab?.claudeConfigDir, m.accounts(), m.envFor) === undefined
        ? "the tab's Claude account could not be matched to one account in Settings" : null;
    },
    restart: (tabId, cwd, phone) => {
      const sender = m.ownerOf(tabId);
      if (!sender || m.movable(tabId, sender)) return false;
      const tab = m.tabs().find((t) => t.id === tabId);
      const pin = pinForBinding(tab?.claudeConfigDir, m.accounts(), m.envFor);
      if (pin === undefined) return false;
      return m.spawn(tabId, cwd, sender, pin, phone) === true;
    },
    tuiSessionIds: async (tabId) => {
      const info = await m.claudeInfo(tabId).catch(() => null);
      if (!info) return [];
      return tuiSessionIdsOf(info, await presenceFor(tabId, info).catch(() => null));
    },
    notify: (tabId, state) => m.notify(tabId, state),
  });
  void refreshPressure();
  return pm;
}

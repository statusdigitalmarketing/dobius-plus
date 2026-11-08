// The phone notifications wired into the app: the notifier (phone-notifier.js), the fan-out to Web Push and APNs
// (phone-push.js, push.js, apns.js), and what main needs to know to decide (settings, tab status, which tab the person
// is looking at). The pure parts are unit tested; this file only connects them to Electron and config.
// Docs: docs/native-push.md, docs/mobile-ws-protocol.md (Notifications and native push).

import path from 'node:path';
import { app, BrowserWindow, powerMonitor, ipcMain } from 'electron';
import { createPhoneNotifier } from './phone-notifier.js';
import { createPhonePush } from './phone-push.js';
import { createApnsSender } from './apns.js';
import { sendPush, hasPushSubscribers } from './push.js';
import { getSettings, getApnsTokens, addApnsToken, removeApnsToken, setApnsTokenEnv, removeApnsTokensByPairToken } from './config-manager.js';
import { isPairedToken, tabLabelForNotify } from './mobile-server.js';
import { statusFor } from './terminal-status.js';
import { getTerminalWebContentsId } from './terminal-manager.js';
import { nudgeSettings } from './mobile-today.js';
import { getQuitting } from './quit-state.js';

const TAB_ID_MAX = 1024;
const MAX_SHOWN = 16;
const LOOKING_IDLE_S = 120; // no keyboard or mouse for two minutes: nobody is looking, whatever is on screen
const shownByWindow = new Map(); // webContents id -> the tab that window shows now (ProjectView reports it)

let apns = null;
let push = null;
let notifier = null;
let handoffWaiting = null;

const logged = new Map(); // code -> last time, so a dead channel does not fill the log
function log(code) {
  const t = Date.now();
  if (t - (logged.get(code) || 0) < 60_000) return;
  logged.set(code, t);
  console.warn('[phone-push]', code); // a fixed code: never a token, a key or a payload
}

// Only phones still paired: a registration left by a phone that was unpaired while it was being stored never gets one.
const liveTokens = () => getApnsTokens()
  .filter((t) => isPairedToken(t.pairToken))
  .map(({ token, env, pairingId, addedAt }) => ({ token, env, pairingId, addedAt }));

/** Whether the person is looking at this tab on the Mac right now: its window focused, showing it, and in use. */
function isLooking(tabId) {
  try {
    const w = BrowserWindow.getFocusedWindow();
    if (!w || w.isDestroyed() || w.isMinimized() || !w.isVisible()) return false;
    const wcId = w.webContents.id;
    if (getTerminalWebContentsId(tabId) !== wcId || !shownByWindow.get(wcId)?.has(tabId)) return false;
    if (powerMonitor.getSystemIdleState(LOOKING_IDLE_S) !== 'active') return false; // idle or the screen is locked
    return true;
  } catch { return false; }
}

export function initPhoneAlerts({ hasWaiting } = {}) {
  if (notifier) return notifier;
  handoffWaiting = typeof hasWaiting === 'function' ? hasWaiting : null;
  apns = createApnsSender({ dir: path.join(app.getPath('userData'), 'apns') });
  push = createPhonePush({
    webPush: sendPush,
    hasWebPush: hasPushSubscribers,
    apns,
    tokens: { list: liveTokens, drop: (token, addedAt) => removeApnsToken(token, addedAt), setEnv: (token, env, addedAt) => setApnsTokenEnv(token, env, addedAt) },
    log,
  });
  notifier = createPhoneNotifier({
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer: (t) => clearTimeout(t),
    settings: () => {
      const st = getSettings();
      const n = nudgeSettings(st.todayNudges);
      return { alerts: st.phoneAlerts, morningAt: n.morningAt, quietAfter: n.quietAfter };
    },
    statusOf: (id) => statusFor(id)?.status || null,
    labelFor: (id) => tabLabelForNotify(id),
    handoffWaiting: (id) => (handoffWaiting ? handoffWaiting(id) : false),
    isLooking,
    quitting: () => getQuitting(),
    send: (n) => push.send(n),
  });
  // The tabs each project window shows (the active one, a split's two, a grid's cells). Fire-and-forget from the
  // renderer; only strings that could be tab ids, at most a grid's worth.
  ipcMain.on('tabs:shown', (event, ids) => {
    const wc = event.sender;
    const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x && x.length <= TAB_ID_MAX).slice(0, MAX_SHOWN) : [];
    if (!shownByWindow.has(wc.id)) wc.once('destroyed', () => shownByWindow.delete(wc.id));
    shownByWindow.set(wc.id, new Set(list));
  });
  return notifier;
}

export const phoneAlerts = {
  tabHook: (id, state, tag) => notifier?.tabHook(id, state, tag),
  tabInput: (id) => notifier?.tabInput(id),
  handoffAdded: (id) => notifier?.handoffAdded(id),
  tabFailed: (id) => notifier?.tabFailed(id),
  teamMessage: (name) => notifier?.teamMessage(name),
  stop: () => notifier?.stop(),

  /** What the phone's Settings shows about whether notifications can reach it. token: that phone's pairing token. */
  channels(token) {
    const c = push ? push.channels() : { webPush: hasPushSubscribers(), apnsReady: false, apnsReason: 'no-key', apnsDevices: 0 };
    const mine = typeof token === 'string' && token ? getApnsTokens().some((t) => t.pairToken === token) : false;
    return { webPush: c.webPush, apnsReady: c.apnsReady, apnsReason: c.apnsReason, thisPhoneApns: mine };
  },
  /** Any phone that a notification could reach right now (Today's nudge uses it). */
  hasAnyPhone() {
    if (hasPushSubscribers()) return true;
    const c = push?.channels();
    return !!(c?.apnsReady && liveTokens().length);
  },
  /** One notification, for the Today nudge (its own rules live in today-nudge.js). */
  send: (n) => (push ? push.send(n) : Promise.resolve()),

  registerApns({ deviceToken, pairToken, pairingId }, stillOk = () => true) {
    if (!stillOk()) return { ok: false, error: 'unavailable' };
    const entry = addApnsToken({ token: deviceToken, pairToken, pairingId });
    if (!entry) return { ok: false, error: 'bad-request' };
    // Unpaired while it was being stored: take it out again (removeMobileDevice ran before the write landed).
    if (!stillOk() || !isPairedToken(pairToken)) { removeApnsTokensByPairToken(pairToken); return { ok: false, error: 'unavailable' }; }
    return { ok: true };
  },
  unregisterApns(pairToken) { removeApnsTokensByPairToken(pairToken); },
  resolveRef: (ref) => (push ? push.resolve(ref) : null),
};

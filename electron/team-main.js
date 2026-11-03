/**
 * Team communicator in the app (docs/team-communicator.md): the store on Electron safeStorage, the service, its IPC,
 * the `dobius-team` bridge command, and notifications. The pure parts live in team-store / team-service /
 * team-deliver / team-protocol / team-crypto and are unit tested; this file only wires them to Electron.
 */
import path from 'node:path';
import { app, safeStorage, ipcMain, BrowserWindow, Notification } from 'electron';
import { createTeamStore } from './team-store.js';
import { createTeamService } from './team-service.js';
import { teamRequest } from './team-net.js';
import { shortFp } from './team-crypto.js';
import { terminalBracketedPaste } from './terminal-manager.js';
import { statusFor } from './terminal-status.js';

let service = null;
let store = null;

/** The service for the phone server's /team routes, or null while this Mac has no usable identity. */
export function getTeamService() {
  if (!service) return null;
  try { store.loadIdentity(); } catch { return null; } // no secure storage: the routes answer 404
  return service;
}

const broadcast = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
};

function toast(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body: String(body || '').slice(0, 200) }).show();
  } catch (err) {
    console.warn('[team] notification failed:', err?.message || err);
  }
}

/**
 * @param {{ bridgeOpenDeps: object, endpoint: () => ({ host, port } | null) }} opts
 *   bridgeOpenDeps: createBridgeOpenDeps(...) from main.js, the same guards /openTab uses.
 */
export function initTeam({ bridgeOpenDeps: w, endpoint }) {
  if (service) return service;
  store = createTeamStore({
    dir: path.join(app.getPath('userData'), 'team'),
    box: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
    },
  });
  service = createTeamService({
    store,
    request: teamRequest,
    endpoint,
    deliverDeps: (tabId, authorized) => ({
      authorized,
      tabAlive: w.tabAlive,
      ptyOf: w.ptyOf,
      claudeRunning: w.claudeRunning,
      inputBusy: w.inputBusy,
      paste: w.paste,
      submit: w.submit,
      sleep: w.sleep,
      now: w.now,
      idle: (id) => statusFor(id)?.status !== 'working',
      watch: (id) => {
        const x = w.watchOutput(id);
        return {
          seq: x.seq, keys: x.keys, input: x.input, stop: x.stop,
          // The bracketed-paste flag as TRACKED over the tab's whole output: the switch that turned it on has
          // usually left the bounded buffer this screen is rendered from.
          screen: async () => {
            const s = await x.screen();
            return s ? { lines: s.lines, modes: { ...s.modes, bracketedPaste: terminalBracketedPaste(id) } } : null;
          },
        };
      },
    }),
    notify: (event, p) => {
      if (event === 'link-request') toast('Team link request', `${p.name} (${p.short}) wants to link. Open Settings > Team to accept.`);
      if (event === 'message') toast(`Team message from ${p.name}`, p.text);
      broadcast('team:changed', { event });
    },
  });
  registerIpc();
  service.start();
  return service;
}

export function stopTeam() {
  service?.stop();
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

function registerIpc() {
  const safe = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  };
  ipcMain.handle('team:status', safe(() => service.status()));
  ipcMain.handle('team:messages', safe(() => ({ ok: true, list: store.messages().slice(-200) })));
  ipcMain.handle('team:invite', safe(() => service.createInvite()));
  ipcMain.handle('team:join', safe((text) => service.join(str(text, 600) || '')));
  ipcMain.handle('team:decideLink', safe((inviteId, accept) => service.decideLink(str(inviteId, 64), accept === true)));
  ipcMain.handle('team:send', safe((to, text) => service.send(str(to, 100), str(text, 8000))));
  ipcMain.handle('team:reply', safe((shortId, text) => service.reply(str(shortId, 16), str(text, 8000))));
  ipcMain.handle('team:retry', safe((id) => service.retry(str(id, 64))));
  ipcMain.handle('team:sendAgain', safe((id) => service.sendAgain(str(id, 64))));
  ipcMain.handle('team:routeNow', safe((peer, id) => service.routeNow(str(peer, 64), str(id, 64))));
  ipcMain.handle('team:updatePeer', safe((id, patch) => {
    const p = store.updatePeer(str(id, 64), patch && typeof patch === 'object' ? patch : {});
    broadcast('team:changed', {});
    return p ? { ok: true } : { ok: false, error: 'no such teammate' };
  }));
  ipcMain.handle('team:unlink', safe((id) => {
    const ok = store.removePeer(str(id, 64));
    broadcast('team:changed', {});
    return { ok };
  }));
  ipcMain.handle('team:settings', safe((patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = {};
    if (typeof p.name === 'string' && p.name.trim()) next.name = p.name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
    if (typeof p.accept === 'boolean') next.accept = p.accept;
    if (p.orchestratorTab === null || (typeof p.orchestratorTab === 'string' && p.orchestratorTab.length <= 1024)) next.orchestratorTab = p.orchestratorTab;
    store.setSettings(next);
    service.settingsChanged();
    broadcast('team:changed', {});
    return { ok: true, settings: store.settings() };
  }));
}

/**
 * The loopback bridge's POST /team (dobius-team). Same token as every Dobius CLI. send and reply are accepted only
 * from the pinned orchestrator tab (DOBIUS_TAB_ID): a guard against a stray session sending by mistake, NOT a
 * security boundary (any process of the user can set that variable; the stated residual in the design).
 */
export function handleTeamBridge(body) {
  if (!service) return { status: 503, json: { ok: false, error: 'Dobius+ is still starting; try again' } };
  const { cmd, arg, text, tabId } = body || {};
  const st = service.status();
  if (!st.ok) return { status: 503, json: { ok: false, error: st.error } };
  if (cmd === 'peers') {
    const lines = st.peers.length
      ? st.peers.map((p) => `${p.name}  ${p.short}  ${p.host}  ${p.enabled ? (p.autoRoute ? 'auto-route' : 'held for a person') : 'disabled'}`)
      : ['no linked teammates (Settings > Team > Invite a teammate)'];
    return { status: 200, json: { ok: true, lines: [`this Mac: ${st.settings.name} ${st.short}`, ...lines] } };
  }
  if (cmd === 'inbox') {
    const lines = store.messages().slice(-20).map((m) => {
      const who = m.peerName || shortFp(m.peer);
      const head = m.dir === 'in' ? `<- ${who}` : `-> ${who}`;
      return `${m.id.slice(0, 8)}  ${head}  [${m.state}]  ${m.text.replace(/\s+/g, ' ').slice(0, 120)}`;
    });
    return { status: 200, json: { ok: true, lines: lines.length ? lines : ['no team messages yet'] } };
  }
  if (cmd !== 'send' && cmd !== 'reply') return { status: 400, json: { ok: false, error: 'unknown command' } };
  const pinned = st.settings.orchestratorTab;
  if (!pinned || tabId !== pinned) {
    return { status: 403, json: { ok: false, error: 'only the team orchestrator tab can send (tab menu > Use as team orchestrator)' } };
  }
  const r = cmd === 'send' ? service.send(String(arg || ''), String(text || '')) : service.reply(String(arg || ''), String(text || ''));
  if (!r.ok) return { status: 400, json: { ok: false, error: r.error } };
  return { status: 200, json: { ok: true, lines: [`queued ${r.short} to ${r.to}; it is retried until they confirm (dobius-team inbox shows the state)`] } };
}

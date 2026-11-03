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
import { oneLine } from './team-deliver.js';
import { terminalInstance } from './terminal-manager.js';
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
      if (event === 'inbox-full') toast('Team inbox full', `A message from ${p.name} was refused: act on the waiting ones in Tasks > Team.`);
      broadcast('team:changed', { event });
    },
  });
  registerIpc();
  try { service.start(); } catch (err) { console.error('[team] could not start:', err?.message || err); }
  return service;
}

export function stopTeam() {
  service?.stop();
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

function registerIpc() {
  // The pinned tab closed by the person (tab bar close, which kills its PTY): unpin, so a later tab can never inherit
  // the pin. main's own terminal:kill listener runs first; a restart of the app keeps the pin (the tab is restored).
  ipcMain.on('terminal:kill', (_e, id) => {
    if (typeof id !== 'string' || store.settings().orchestratorTab !== id || terminalInstance(id)) return;
    store.setSettings({ orchestratorTab: null });
    broadcast('team:changed', {});
  });
  const safe = (fn) => async (_e, ...args) => {
    try { return await fn(...args); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
  };
  ipcMain.handle('team:status', safe(() => service.status()));
  ipcMain.handle('team:messages', safe(() => ({ ok: true, list: service.messagesForUi() })));
  ipcMain.handle('team:invite', safe(() => service.createInvite()));
  ipcMain.handle('team:join', safe((text) => service.join(str(text, 600) || '')));
  ipcMain.handle('team:decideLink', safe((inviteId, accept) => service.decideLink(str(inviteId, 64), accept === true)));
  ipcMain.handle('team:send', safe((to, text) => service.send(str(to, 100), str(text, 8000))));
  ipcMain.handle('team:reply', safe((peer, id, text) => service.reply(str(id, 64), str(text, 8000), str(peer, 64))));
  ipcMain.handle('team:dismiss', safe((dir, peer, id) => service.dismiss(dir === 'out' ? 'out' : 'in', str(peer, 64), str(id, 64))));
  ipcMain.handle('team:retry', safe((id) => service.retry(str(id, 64))));
  ipcMain.handle('team:sendAgain', safe((id) => service.sendAgain(str(id, 64))));
  ipcMain.handle('team:routeNow', safe((peer, id) => service.routeNow(str(peer, 64), str(id, 64))));
  ipcMain.handle('team:updatePeer', safe((id, patch) => {
    const p = store.updatePeer(str(id, 64), patch && typeof patch === 'object' ? patch : {});
    broadcast('team:changed', {});
    return p ? { ok: true } : { ok: false, error: 'no such teammate' };
  }));
  ipcMain.handle('team:unlink', safe((id) => service.unlink(str(id, 64))));
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
      ? st.peers.map((p) => `${oneLine(p.name, 80)}  ${p.short}  ${p.host}  ${p.enabled ? (p.autoRoute ? 'auto-route' : 'held for a person') : 'disabled'}`)
      : ['no linked teammates (Settings > Team > Invite a teammate)'];
    return { status: 200, json: { ok: true, lines: [`this Mac: ${oneLine(st.settings.name, 80)} ${st.short}`, ...lines] } };
  }
  if (cmd === 'inbox') {
    const lines = store.messages().slice(-20).map((m) => {
      // Printed into a terminal: teammate-supplied text never carries an escape or control character.
      const who = oneLine(m.peerName, 80) || shortFp(m.peer);
      const head = m.dir === 'in' ? `<- ${who}` : `-> ${who}`;
      return `${m.id}@${m.peer}  ${head}  [${m.state}]  ${oneLine(m.text, 400).replace(/\s+/g, ' ').slice(0, 120)}`;
    });
    return { status: 200, json: { ok: true, lines: lines.length ? lines : ['no team messages yet'] } };
  }
  if (cmd !== 'send' && cmd !== 'reply') return { status: 400, json: { ok: false, error: 'unknown command' } };
  const pinned = st.settings.orchestratorTab;
  if (!pinned || tabId !== pinned) {
    return { status: 403, json: { ok: false, error: 'only the team orchestrator tab can send (tab menu > Use as team orchestrator)' } };
  }
  // A reply names its sender (id@fingerprint, as the card prints it): ids are unique only per sender, and a bare id
  // could come to match another teammate's message once the original row has left the list.
  if (cmd === 'reply' && !String(arg || '').includes('@')) {
    return { status: 400, json: { ok: false, error: 'reply needs the id@fingerprint form printed on the message card (or by dobius-team inbox)' } };
  }
  const r = cmd === 'send' ? service.send(String(arg || ''), String(text || '')) : service.reply(String(arg || ''), String(text || ''));
  if (!r.ok) return { status: 400, json: { ok: false, error: r.error } };
  return { status: 200, json: { ok: true, lines: [`queued ${r.short} to ${r.to}; it is retried until they confirm (dobius-team inbox shows the state)`] } };
}

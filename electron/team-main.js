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
import { terminalInstance, addInputObserver, getTerminalClaudeInfo } from './terminal-manager.js';
import { isOwnWrite } from './bridge-open-main.js';
import { submitsInput } from '../shared/prompt-answer.js';
import { terminalBracketedPaste } from './terminal-manager.js';
import { statusFor, waitingOnBackground, onHookState } from './terminal-status.js';

let service = null;
let store = null;

/** The service for the phone server's /team routes, or null while this Mac has no usable identity. */
/** The tab pinned as team orchestrator, or null (no pin, or team storage unavailable). */
export function teamOrchestratorTab() {
  try { const t = store?.settings()?.orchestratorTab; return typeof t === 'string' && t ? t : null; } catch { return null; }
}

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
// onMessage(peerName): a team message arrived (the phone notifier; the name only, never the text).
export function initTeam({ bridgeOpenDeps: w, endpoint, endpointProblem, onMessage = () => {} }) {
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
    endpointProblem,
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
      // Working only on background tasks (a dev server Claude started) is idle at the prompt: the screen and terminal
      // checks still decide whether it may be typed into.
      idle: (id) => statusFor(id)?.status !== 'working' || waitingOnBackground(id),
      background: (id) => waitingOnBackground(id),
      claudePid: async (id) => (await getTerminalClaudeInfo(id, { unique: true }))?.pid ?? null,
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
      if (event === 'message') {
        toast(`Team message from ${p.name}`, p.text);
        try { onMessage(p.name); } catch (err) { console.warn('[team] phone notify failed:', err?.message || err); }
      }
      if (event === 'held') {
        const names = [...new Set((p.names || []).map((n) => oneLine(n, 80)).filter(Boolean))];
        const n = (p.names || []).length || 1;
        const from = names.length ? `From ${names.join(', ')}. ` : '';
        if (p.state === 'needs attention') toast('Team message needs a look', `${from}${p.note || 'typed in, not confirmed sent'}. Check your orchestrator tab.`);
        else toast(n > 1 ? `${n} team messages waiting for you` : 'Team message waiting for you', `${from}Not typed into your orchestrator tab: ${p.note || 'unknown reason'}. Read ${n > 1 ? 'them' : 'it'} in Tasks > Team.`);
      }
      if (event === 'waiting-long') {
        toast('Team message waiting for your orchestrator tab', `From ${oneLine(p.name, 80)}: the pinned tab has been busy for 5 minutes, so it is not typed in yet${p.queued ? ` (${p.queued} more behind it)` : ''}. Free that tab, or read it in Tasks > Team.`);
      }
      if (event === 'handoff-held') toast('Team request not handed over', `A message for ${p.to} could not be typed into the orchestrator tab: ${p.note || 'unknown reason'}. Nothing was sent.`);
      if (event === 'inbox-full') toast('Team inbox full', `A message from ${p.name} was refused: act on the waiting ones in Tasks > Team.`);
      broadcast('team:changed', { event });
    },
  });
  registerIpc();
  // What a delivered message led to on this Mac (working, done, the tab closing) is reported back to its sender.
  // The Claude that took the followed message must still be the one running: a second claude chained after it
  // (`claude; claude ...`) starts with no Enter in between, so its hooks are checked here too.
  const claudeGone = (id) => {
    const pid = service.followedPid(id);
    if (!pid) return false;
    try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
  };
  onHookState((id, state, tag) => {
    if (state !== 'exit' && claudeGone(id)) service.tabEvent(id, 'claude-gone', null);
    service.tabEvent(id, state, tag);
  });
  // A person pressing Enter in a tab (never Dobius's own paste and Enter): ends following a message whose turn is over.
  addInputObserver((id, data) => {
    // Any line break: Enter, and Ctrl+J, which a shell also runs a command on. (In Claude's box Ctrl+J is a newline in a
    // draft; counting it only ends following sooner, the safe direction.)
    if (isOwnWrite()) return;
    if (data === '\x1b' || data === '\x03') { service.tabEvent(id, 'person-interrupt', null); return; }
    if (!(submitsInput(data) || /[\r\n]/.test(data))) return;
    // The Claude that took the followed message is gone (crashed or quit): whatever is typed now, a fresh `claude`
    // included, is not that message's work. A signal-0 probe of THAT pid, synchronous, so it cannot race this Enter.
    // ponytail: pid only, no start time; reuse of the same pid within the 6 hour window is the accepted ceiling, and
    // so is a SUSPENDED original (Ctrl+Z) with a second claude started in the same shell (signal 0 still succeeds).
    if (claudeGone(id)) service.tabEvent(id, 'claude-gone', null);
    service.tabEvent(id, 'person-submit', null);
  });
  try { service.start(); } catch (err) { console.error('[team] could not start:', err?.message || err); }
  return service;
}

export function stopTeam() {
  service?.stop();
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** Where a message is now and since when: an outgoing one's last report from the teammate, else its own state. */
function stageOf(m) {
  if (m.dir === 'out' && m.stage) return { stage: m.stage, since: m.stageAt || m.at, note: m.stageNote };
  if (m.dir === 'out' && m.state === 'delivered') return { stage: 'delivered', since: m.deliveredAt || m.at, note: null };
  return { stage: m.state, since: m.routedAt || m.at, note: m.note };
}

/** One message by `id@fingerprint` (either direction), or null when none or more than one match. */
function findRef(ref, dir = null) {
  const r = String(ref || '').trim();
  const at = r.indexOf('@');
  if (at <= 0) return null;
  const hits = store.messages().filter((x) => x.id === r.slice(0, at) && x.peer === r.slice(at + 1) && (!dir || x.dir === dir));
  return hits.length === 1 ? hits[0] : null;
}

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
  ipcMain.handle('team:archive', safe((dir, peer, id, on) => service.archive(dir === 'out' ? 'out' : 'in', str(peer, 64), str(id, 64), on !== false)));
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
 * The loopback bridge's POST /team (dobius-team). Same token as every Dobius CLI. send and reply SEND only from the
 * pinned orchestrator tab (DOBIUS_TAB_ID); from any other tab they are handed to the orchestrator as a request it
 * approves with `dobius-team approve <id>` (pinned tab only). A guard against a stray session sending by mistake, NOT
 * a security boundary (any process of the user can set that variable; the stated residual in the design).
 */
// Its reply goes out through voice-bridge's sendJson, which takes harness markup out of every string (teammate names,
// bodies, failure notes reach the reading Claude as tool output).
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
    const t = Date.now();
    const lines = store.messages().slice(-20).map((m) => {
      // Printed into a terminal: teammate-supplied text never carries an escape or control character.
      const who = oneLine(store.nameFor(m), 80) || shortFp(m.peer);
      const head = m.dir === 'in' ? `<- ${who}` : `-> ${who}`;
      const { stage, since, note } = stageOf(m);
      const why = note ? ` (${oneLine(note, 120)})` : '';
      return `${m.id}@${m.peer}  ${head}  [${stage} ${ago(t - since)}]${why}  ${oneLine(m.text, 400).replace(/\s+/g, ' ').slice(0, 120)}`;
    });
    // Teammate-supplied text (bodies, failure notes) reaches the reading Claude as tool output: no harness markup.
    return { status: 200, json: { ok: true, lines: lines.length ? lines : ['no team messages yet'] } };
  }
  if (cmd === 'show') {
    const m = findRef(arg);
    if (!m) return { status: 400, json: { ok: false, error: 'no single message has that id@fingerprint (dobius-team inbox prints them)' } };
    const t = Date.now();
    const when = (x) => `${new Date(x).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} (${ago(t - x)} ago)`;
    const lines = [
      `${m.dir === 'in' ? 'from' : 'to'} ${oneLine(store.nameFor(m), 80) || shortFp(m.peer)}  ${m.kind}${m.replyTo ? ` to ${m.replyTo.slice(0, 8)}` : ''}  id ${m.id}`,
      `  ${m.dir === 'in' ? 'received' : 'queued'}  ${when(m.firstSentAt && m.dir === 'out' ? m.firstSentAt : m.at)}`,
    ];
    if (m.dir === 'out') {
      if (m.deliveredAt) lines.push(`  delivered  ${when(m.deliveredAt)}`);
      for (const e of Array.isArray(m.timeline) ? m.timeline : []) {
        lines.push(`  ${e.state}  ${when(e.at)}${e.note ? `  ${oneLine(e.note, 200)}` : ''}${e.replyId ? `  reply ${e.replyId.slice(0, 8)}` : ''}`);
      }
      if (!m.deliveredAt) lines.push(`  now: ${m.state}${m.note ? ` (${oneLine(m.note, 200)})` : ''}`);
    } else {
      lines.push(`  now: ${m.state}${m.note ? ` (${oneLine(m.note, 200)})` : ''}`);
      const owed = Array.isArray(m.reports) ? m.reports.length : 0;
      if (owed) lines.push(`  ${owed} status report(s) not yet confirmed by the sender`);
    }
    // The whole message, line by line (it used to stop at 200 characters, with no way to read the rest). Each line is
    // made safe for a terminal; the text is at most MAX_TEXT (8000) characters, so this stays bounded.
    lines.push('  text:');
    for (const l of String(m.text || '').split(/\r\n?|[\n\x0b\x0c\x85\u2028\u2029]/)) lines.push(`  | ${l.toWellFormed().replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, ' ')}`); // indentation kept, controls never printed, a lone surrogate (which breaks the CLI's UTF-8 print) becomes U+FFFD
    return { status: 200, json: { ok: true, lines } };
  }
  if (!['send', 'reply', 'approve', 'release', 'done', 'failed'].includes(cmd)) return { status: 400, json: { ok: false, error: 'unknown command' } };
  const pinned = st.settings.orchestratorTab;
  if (!pinned) {
    return { status: 403, json: { ok: false, error: 'no team orchestrator tab is pinned (tab menu > Use as team orchestrator)' } };
  }
  if (cmd === 'release' || cmd === 'done' || cmd === 'failed') {
    if (tabId !== pinned) return { status: 403, json: { ok: false, error: `only the team orchestrator tab can run ${cmd}` } };
    if (cmd === 'release') {
      const m = findRef(arg, 'in');
      if (!m || m.dir !== 'in') return { status: 400, json: { ok: false, error: 'no single received message has that id@fingerprint' } };
      if (m.state === 'needs attention') return { status: 400, json: { ok: false, error: 'that one was typed in but not confirmed sent: check the orchestrator tab, then dismiss it in Tasks > Team' } };
      const r = service.routeNow(m.peer, m.id);
      if (!r.ok) return { status: 400, json: { ok: false, error: r.error } };
      return { status: 200, json: { ok: true, lines: [`releasing ${m.id.slice(0, 8)}: it is typed into this tab when Claude is idle`] } };
    }
    const r = service.markIncoming(String(arg || ''), cmd, typeof text === 'string' && text.trim() ? text.trim().slice(0, 300) : null);
    if (!r.ok) return { status: 400, json: { ok: false, error: r.error } };
    return { status: 200, json: { ok: true, lines: [`told ${r.to} that ${r.short} is ${cmd}`] } };
  }
  if (cmd === 'approve') {
    if (tabId !== pinned) return { status: 403, json: { ok: false, error: 'only the team orchestrator tab can approve a request' } };
    const r = service.approveHandoff(String(arg || ''));
    if (!r.ok) return { status: 400, json: { ok: false, error: r.error } };
    return { status: 200, json: { ok: true, lines: [`queued ${r.short} to ${r.to}; it is retried until they confirm (dobius-team inbox shows the state)`] } };
  }
  if (tabId !== pinned) {
    // Another tab: handed to the orchestrator as a request it checks and approves. Nothing is sent from here. Only from
    // a live Dobius tab, so one caller cannot dodge the per-tab cap with made-up tab ids.
    if (typeof tabId !== 'string' || !terminalInstance(tabId)) {
      return { status: 403, json: { ok: false, error: 'run this in a Dobius+ tab (it hands the message to the team orchestrator tab)' } };
    }
    const r = service.handoff({ cmd, arg: String(arg || ''), text: String(text || ''), fromTab: tabId });
    if (!r.ok) return { status: 400, json: { ok: false, error: r.error } };
    return { status: 200, json: { ok: true, lines: [`handed to the team orchestrator tab (request ${r.hid}); it sends to ${r.to} once it checks and approves it. Not sent yet.`] } };
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

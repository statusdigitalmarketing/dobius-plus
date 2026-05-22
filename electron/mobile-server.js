/**
 * Mobile server — embedded HTTP + WebSocket server that bridges Dobius+ to a
 * phone PWA over the user's Tailscale tailnet.
 *
 * Phase 1: server lifecycle, Tailscale-only binding, and the pairing flow.
 * The terminal bridge protocol is added in Phase 2.
 *
 * Security model:
 *  - Binds ONLY to the Mac's tailnet IP (100.64.0.0/10), never 0.0.0.0 or LAN.
 *    If there's no tailnet address the server refuses to start.
 *  - A phone pairs once with an ephemeral 6-digit code, then receives a
 *    long-lived device token. The token is required on every WebSocket connect.
 *  - The pairing code is brute-force-limited: 5 bad attempts invalidate it
 *    until the user regenerates it from the desktop.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import { getMobileServerConfig, updateMobileServerConfig } from './config-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_PAIR_ATTEMPTS = 5;
const AUTH_TIMEOUT_MS = 5000;

let httpServer = null;
let wss = null;
let pairingCode = null;   // ephemeral, regenerated on each start
let pairAttempts = 0;
let boundAddress = null;  // { host, port }

/** Find the Mac's Tailscale (CGNAT 100.64.0.0/10) IPv4 address, or null. */
function getTailnetIp() {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        const [o1, o2] = a.address.split('.').map(Number);
        if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
      }
    }
  }
  return null;
}

function genPairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function knownToken(token) {
  if (!token || typeof token !== 'string') return false;
  return getMobileServerConfig().devices.some((d) => d.token === token);
}

/** Current server status, safe to expose to the renderer. */
export function getMobileServerStatus() {
  return {
    running: !!httpServer,
    tailnetIp: getTailnetIp(),
    address: boundAddress,
    pairingCode: httpServer ? pairingCode : null,
    deviceCount: getMobileServerConfig().devices.length,
  };
}

/** Start the server. Resolves to a status object (with `error` set on failure). */
export async function startMobileServer() {
  if (httpServer) return getMobileServerStatus();

  const ip = getTailnetIp();
  if (!ip) {
    return { running: false, error: 'No Tailscale connection found. Open Tailscale, sign in, then try again.' };
  }
  const port = getMobileServerConfig().port || 8420;

  const expApp = express();
  expApp.use(express.json({ limit: '64kb' }));

  expApp.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'dobius-plus', version: app.getVersion() });
  });

  expApp.post('/pair', (req, res) => {
    if (!pairingCode) {
      return res.status(403).json({ ok: false, error: 'Pairing is locked. Regenerate the code on the desktop.' });
    }
    const { code, deviceName } = req.body || {};
    if (code !== pairingCode) {
      pairAttempts += 1;
      if (pairAttempts >= MAX_PAIR_ATTEMPTS) pairingCode = null;
      return res.status(403).json({ ok: false, error: 'Invalid pairing code.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const cfg = getMobileServerConfig();
    const devices = [...cfg.devices, {
      token,
      name: typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 60) : 'Phone',
      pairedAt: Date.now(),
    }];
    updateMobileServerConfig({ devices });
    // Consume the code after a successful pair so it can't be reused.
    pairingCode = genPairingCode();
    pairAttempts = 0;
    res.json({ ok: true, token });
  });

  // Serve the mobile PWA build if present (added in Phase 3), else a placeholder.
  const mobileDist = path.join(__dirname, '..', 'dist-mobile');
  if (fs.existsSync(path.join(mobileDist, 'index.html'))) {
    expApp.use(express.static(mobileDist));
  } else {
    expApp.get('/', (_req, res) => {
      res.type('html').send(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<body style="font-family:-apple-system;background:#0D1117;color:#E6EDF3;padding:2rem">'
        + '<h2>Dobius+ Mobile</h2><p>Server is running. The mobile app ships in a later update.</p></body>'
      );
    });
  }

  httpServer = http.createServer(expApp);

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (socket) => {
    let authed = false;
    const authTimer = setTimeout(() => { if (!authed) socket.close(4001, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!authed) {
        if (msg.type === 'auth' && knownToken(msg.token)) {
          authed = true;
          clearTimeout(authTimer);
          socket.send(JSON.stringify({ type: 'authed', version: app.getVersion() }));
        } else {
          socket.close(4003, 'unauthorized');
        }
        return;
      }
      // Phase 2 wires the terminal protocol here.
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
    socket.on('close', () => clearTimeout(authTimer));
    socket.on('error', () => clearTimeout(authTimer));
  });

  pairingCode = genPairingCode();
  pairAttempts = 0;

  return new Promise((resolve) => {
    const onError = (err) => {
      httpServer = null;
      wss = null;
      boundAddress = null;
      pairingCode = null;
      resolve({ running: false, error: String(err?.message || err) });
    };
    httpServer.once('error', onError);
    httpServer.listen(port, ip, () => {
      httpServer.removeListener('error', onError);
      // Permanent handler so a later runtime socket error logs instead of crashing.
      httpServer.on('error', (err) => console.warn('[mobile-server]', err?.message || err));
      boundAddress = { host: ip, port };
      updateMobileServerConfig({ enabled: true });
      resolve(getMobileServerStatus());
    });
  });
}

/** Stop the server. Resolves to a status object. */
export function stopMobileServer() {
  if (wss) { try { wss.close(); } catch { /* noop */ } wss = null; }
  if (httpServer) { try { httpServer.close(); } catch { /* noop */ } httpServer = null; }
  boundAddress = null;
  pairingCode = null;
  pairAttempts = 0;
  updateMobileServerConfig({ enabled: false });
  return getMobileServerStatus();
}

/** Regenerate the pairing code (only meaningful while running). */
export function regeneratePairingCode() {
  if (!httpServer) return null;
  pairingCode = genPairingCode();
  pairAttempts = 0;
  return pairingCode;
}

/** Remove a paired device by token. */
export function removeMobileDevice(token) {
  const cfg = getMobileServerConfig();
  updateMobileServerConfig({ devices: cfg.devices.filter((d) => d.token !== token) });
  return getMobileServerStatus();
}

/** Start on launch if the user previously enabled it. */
export async function maybeAutoStartMobileServer() {
  if (getMobileServerConfig().enabled) {
    return startMobileServer();
  }
  return getMobileServerStatus();
}

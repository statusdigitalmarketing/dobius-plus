// Tailscale helpers for HTTPS on the mobile server (v1.0.43 Phase 4).
//
// Web Push + service-worker install require a secure context, and a browser-
// trusted cert on the tailnet must use the MagicDNS name (not the 100.x IP).
// This resolves the Mac's MagicDNS name, manages the cert files, and can
// provision them via `tailscale cert`. If the tailnet has not enabled HTTPS
// certificates, provisioning fails with a clear message and the server stays on
// plain HTTP (terminal-only, no push/install).

import fsSync from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { app } from 'electron';

const TS_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

export function tailscaleBin() {
  for (const p of TS_CANDIDATES) {
    try { fsSync.accessSync(p, fsSync.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function run(bin, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** The Mac's MagicDNS name (no trailing dot), or null. */
export async function getMagicDNSName() {
  const bin = tailscaleBin();
  if (!bin) return null;
  const { err, stdout } = await run(bin, ['status', '--json']);
  if (err) return null;
  try {
    const j = JSON.parse(stdout);
    const name = j?.Self?.DNSName;
    if (typeof name === 'string' && name) return name.replace(/\.$/, '');
  } catch { /* fall through */ }
  return null;
}

/**
 * Pure: the hosts that are THIS tailnet's own machines, from `tailscale status
 * --json`: this Mac plus every peer whose MagicDNS name is under the tailnet's
 * own suffix, as lowercase URL hostnames (DNS names without the trailing dot,
 * IPv4, and IPv6 in brackets). A machine shared INTO this tailnet keeps its
 * owner's suffix, and a ShareeNode is someone else's, so neither is listed:
 * the mobile server's CORS allows exactly these (Codex High, two rounds).
 */
export function tailnetHostsFrom(status) {
  const hosts = new Set();
  const suffix = String(status?.MagicDNSSuffix || status?.CurrentTailnet?.MagicDNSSuffix || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.ts\.net$/.test(suffix)) return hosts;
  const add = (node) => {
    const name = String(node?.DNSName || '').toLowerCase().replace(/\.$/, '');
    if (!name.endsWith(`.${suffix}`) || node?.ShareeNode === true) return;
    hosts.add(name);
    for (const ip of Array.isArray(node?.TailscaleIPs) ? node.TailscaleIPs : []) {
      const v = String(ip).toLowerCase();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) hosts.add(v);
      else if (/^[0-9a-f:]+$/.test(v)) hosts.add(`[${v}]`);
    }
  };
  add(status?.Self);
  for (const peer of Object.values(status?.Peer || {})) add(peer);
  return hosts;
}

/** This tailnet's own hosts (see tailnetHostsFrom), or null when unknown. */
export async function getTailnetHosts() {
  const bin = tailscaleBin();
  if (!bin) return null;
  const { err, stdout } = await run(bin, ['status', '--json']);
  if (err) return null;
  try { return tailnetHostsFrom(JSON.parse(stdout)); } catch { return null; }
}

/** Where Dobius keeps the tailnet TLS cert/key (0700 dir). */
export function certDir() {
  const d = path.join(app.getPath('userData'), 'tls');
  try { fsSync.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  return d;
}

export function certPathsFor(name) {
  if (!name || !/^[a-z0-9.-]+$/i.test(name)) return null; // MagicDNS names only
  const d = certDir();
  return { certFile: path.join(d, `${name}.crt`), keyFile: path.join(d, `${name}.key`) };
}

/** True if a usable cert+key pair exists for the current MagicDNS name. */
export function hasCertFor(name) {
  const p = certPathsFor(name);
  if (!p) return false;
  try {
    return fsSync.statSync(p.certFile).size > 0 && fsSync.statSync(p.keyFile).size > 0;
  } catch {
    return false;
  }
}

/**
 * Provision a browser-trusted cert for the MagicDNS name via `tailscale cert`.
 * Returns { ok:true, name } or { ok:false, error }. Fails clearly when the
 * tailnet has not enabled HTTPS certificates (the common first-run case).
 */
export async function provisionCert() {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, error: 'Tailscale CLI not found.' };
  const name = await getMagicDNSName();
  if (!name) return { ok: false, error: 'Could not read your Tailscale MagicDNS name. Is Tailscale running?' };
  const p = certPathsFor(name);
  if (!p) return { ok: false, error: 'Invalid MagicDNS name.' };
  const { err, stderr } = await run(bin, ['cert', '--cert-file', p.certFile, '--key-file', p.keyFile, name], 60000);
  if (err) {
    const hint = /HTTPS|not enabled|feature/i.test(stderr)
      ? 'Enable HTTPS Certificates for your tailnet in the Tailscale admin console, then retry.'
      : (stderr.trim().split('\n').pop() || 'tailscale cert failed').slice(0, 200);
    return { ok: false, error: hint };
  }
  return { ok: true, name };
}

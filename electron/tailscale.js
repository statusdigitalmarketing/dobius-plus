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
import { X509Certificate } from 'crypto';
import tls from 'tls';
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

// Tailscale.app's binary is the CLI only when TERM is set. Without it (any
// app opened from the Dock or Finder) it tries to launch the GUI instead,
// prints "The Tailscale GUI failed to start" and EXITS 0, which is why
// "Enable HTTPS" used to report success and write no certificate.
const CLI_ENV = { ...process.env, TERM: process.env.TERM || 'dumb' };

function run(bin, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: CLI_ENV }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function statusJson() {
  const bin = tailscaleBin();
  if (!bin) return null;
  const { err, stdout } = await run(bin, ['status', '--json']);
  if (err) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

/** The Mac's MagicDNS name (no trailing dot), or null. */
export async function getMagicDNSName() {
  const name = (await statusJson())?.Self?.DNSName;
  return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
}

/**
 * The MagicDNS name when the tailnet can issue it a certificate (HTTPS
 * Certificates on in the admin console), else null.
 */
export async function certCapableName() {
  const j = await statusJson();
  const name = typeof j?.Self?.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : '';
  const domains = Array.isArray(j?.CertDomains) ? j.CertDomains : [];
  return name && domains.includes(name) ? name : null;
}

/**
 * When the cert for `name` expires (ms since epoch), or null when there is no
 * cert+key pair on disk or the key does not belong to the cert. Read from the
 * cert itself: the file's mtime says nothing, since tailscale may hand back a
 * cached cert issued weeks earlier.
 */
export function certValidTo(name) {
  const p = certPathsFor(name);
  if (!p) return null;
  try {
    const cert = fsSync.readFileSync(p.certFile);
    // The same load the HTTPS server does: parses the whole chain (X509 alone
    // reads only the leaf) and throws when the key does not match.
    tls.createSecureContext({ cert, key: fsSync.readFileSync(p.keyFile) });
    const t = Date.parse(new X509Certificate(cert).validTo);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
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
  const prior = certValidTo(name);
  // Ask for 30 days of life so a cached cert near expiry is renewed; an older
  // tailscale without the flag gets the plain call.
  const args = ['cert', '--cert-file', p.certFile, '--key-file', p.keyFile];
  let r = await run(bin, [...args, '--min-validity', '720h', name], 60000);
  if (r.err && /flag provided but not defined/i.test(r.stderr)) r = await run(bin, [...args, name], 60000);
  const { err, stdout, stderr } = r;
  // Success is a cert+key pair on disk with life left in it, never the exit
  // code alone (see CLI_ENV: a GUI-launched CLI exits 0 having written nothing).
  const validTo = certValidTo(name);
  if (!err && !(validTo && validTo - Date.now() > 7 * 86_400_000)) {
    const said = `${stdout}\n${stderr}`.trim().split('\n').filter(Boolean).pop() || '';
    return { ok: false, error: `tailscale cert produced no usable certificate. ${said}`.trim().slice(0, 240) };
  }
  if (err) {
    const hint = /HTTPS|not enabled|feature/i.test(stderr)
      ? 'Enable HTTPS Certificates for your tailnet in the Tailscale admin console, then retry.'
      : (stderr.trim().split('\n').pop() || 'tailscale cert failed').slice(0, 200);
    return { ok: false, error: hint };
  }
  // changed: false when tailscale handed back the cert already on disk.
  return { ok: true, name, changed: certValidTo(name) !== prior };
}

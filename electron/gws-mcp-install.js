// One-click Claude Desktop setup for the gws-mcp server (v1.0.63).
//
// Sam (8/17): "can we have some sort of button in the settings that
// automatically adds it to where it needs to go for claude desktop... let's
// say i go to my brother's house and download dobius on his computer."
//
// Portability model (same tricks as the gws terminal shim):
// - The server source (electron/gws-mcp.mjs) ships inside the asar. Install
//   copies it to <userData>/gws-mcp/ and writes a tiny wrapper that runs it
//   under Dobius's OWN Electron binary with ELECTRON_RUN_AS_NODE=1, so the
//   target Mac needs NO node install.
// - Claude Desktop's config lives at the same per-user path on every Mac:
//   ~/Library/Application Support/Claude/claude_desktop_config.json. Install
//   MERGES an mcpServers.gws entry into it (other servers untouched), with a
//   timestamped backup and an atomic write. Re-running is an upsert, so the
//   entry heals itself after the app moves or updates.
// - The gws CLI is still a prerequisite for actual calls (the server shells
//   out to it), so status() reports whether it is present; the UI surfaces
//   the install command instead of failing mysteriously later.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { fileURLToPath } from 'url';
import { resolveRealGws } from './gws-accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_NAME = 'gws';

function claudeDesktopDir() {
  // Test/harness override so ship-tests never touch the real per-user config.
  if (process.env.DOBIUS_CLAUDE_DESKTOP_DIR) return process.env.DOBIUS_CLAUDE_DESKTOP_DIR;
  return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
}

function configPath() {
  return path.join(claudeDesktopDir(), 'claude_desktop_config.json');
}

function claudeDesktopAppPresent() {
  for (const p of ['/Applications/Claude.app', path.join(os.homedir(), 'Applications', 'Claude.app')]) {
    try { fs.accessSync(p); return true; } catch { /* next */ }
  }
  return false;
}

function gwsCliPresent() {
  // The same lookup every other gws caller uses (login-shell PATH, npm's prefix, nvm, volta...), not two fixed folders.
  return !!resolveRealGws(path.join(app.getPath('userData'), 'gws-shim'));
}

/** POSIX single-quote escaping: immune to $, backticks, spaces, quotes. */
export function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The wrapper script body. Pure, for tests. */
export function wrapperScript(execPath, destJs) {
  // Single quotes, not double: a path like "Dobius $OLD.app" would have its
  // $OLD expanded by /bin/sh inside double quotes (Codex Low).
  return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shSingleQuote(execPath)} ${shSingleQuote(destJs)} "$@"\n`;
}

/**
 * Copy the bundled server out of the asar and (re)write the wrapper that runs
 * it under our own binary. Called on every install AND on app launch when an
 * install exists, so the wrapper always points at the CURRENT app binary
 * (same self-heal ensureShim does; covers the app moving after install).
 * Returns { wrapperPath } or throws.
 */
export function ensureGwsMcpMaterialized() {
  const dir = path.join(app.getPath('userData'), 'gws-mcp');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'gws-mcp.mjs');
  const destJs = path.join(dir, 'gws-mcp.mjs');
  fs.copyFileSync(src, destJs);
  const wrapperPath = path.join(dir, 'gws-mcp');
  fs.writeFileSync(wrapperPath, wrapperScript(process.execPath, destJs), { mode: 0o755 });
  // writeFileSync's mode only applies on CREATE; an existing 0644 wrapper
  // would stay non-executable and Claude Desktop would get EACCES (Codex).
  fs.chmodSync(wrapperPath, 0o755);
  return { wrapperPath };
}

/** Self-heal on launch: refresh an EXISTING install, never create one. */
export function healGwsMcpIfInstalled() {
  try {
    const dir = path.join(app.getPath('userData'), 'gws-mcp');
    if (fs.existsSync(dir)) ensureGwsMcpMaterialized();
  } catch (e) {
    console.warn('[gws-mcp] self-heal failed:', e?.message || e);
  }
}

/**
 * Pure merge: existing config text (or null when the file does not exist) +
 * the wrapper path -> the next config object. Exported for unit tests.
 * A malformed existing file returns { error } rather than clobbering: the
 * user's hand-written config deserves a refusal, not silent replacement.
 */
export function mergeClaudeDesktopConfig(existingText, wrapperPath) {
  let cfg = {};
  if (existingText !== null && existingText !== undefined && String(existingText).trim() !== '') {
    try {
      cfg = JSON.parse(existingText);
    } catch {
      return { error: 'claude_desktop_config.json exists but is not valid JSON. Fix or remove it, then retry.' };
    }
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
      return { error: 'claude_desktop_config.json has an unexpected shape (not an object). Fix it, then retry.' };
    }
  }
  const servers = (typeof cfg.mcpServers === 'object' && cfg.mcpServers !== null && !Array.isArray(cfg.mcpServers))
    ? cfg.mcpServers
    : {};
  return {
    next: {
      ...cfg,
      mcpServers: { ...servers, [SERVER_NAME]: { command: wrapperPath } },
    },
  };
}

/** Current setup state, for the Settings row. */
export function gwsMcpStatus() {
  let configured = false;
  let entryCurrent = false;
  const dir = path.join(app.getPath('userData'), 'gws-mcp');
  const wrapperPath = path.join(dir, 'gws-mcp');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const entry = cfg?.mcpServers?.[SERVER_NAME];
    configured = !!entry;
    if (entry?.command === wrapperPath) {
      // "Current" means it would actually LAUNCH: executable bit set, the
      // server file present, and the wrapper pointing at the binary we are
      // running from right now. existsSync alone said "Set up" for a dead
      // wrapper after the app moved or lost its +x (Codex Medium).
      fs.accessSync(wrapperPath, fs.constants.X_OK);
      const text = fs.readFileSync(wrapperPath, 'utf8');
      entryCurrent = text.includes(shSingleQuote(process.execPath))
        && fs.existsSync(path.join(dir, 'gws-mcp.mjs'));
    }
  } catch { /* missing/unreadable/not executable = not current */ }
  return {
    configured,
    entryCurrent,
    desktopAppPresent: claudeDesktopAppPresent(),
    gwsCliPresent: gwsCliPresent(),
  };
}

/**
 * The button: materialize the server, merge the config entry, atomic write
 * with a timestamped backup. Returns { ok, message } (never throws to IPC).
 */
export function installGwsMcp() {
  try {
    const { wrapperPath } = ensureGwsMcpMaterialized();
    const dir = claudeDesktopDir();
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = configPath();
    let existingText = null;
    try { existingText = fs.readFileSync(cfgPath, 'utf8'); } catch { /* first install */ }
    const merged = mergeClaudeDesktopConfig(existingText, wrapperPath);
    if (merged.error) return { ok: false, message: merged.error };
    if (existingText !== null) {
      // Keep the user's previous config recoverable; one backup per install.
      const backup = path.join(dir, `claude_desktop_config.backup-${Date.now()}.json`);
      try { fs.writeFileSync(backup, existingText, { mode: 0o600 }); } catch { /* best effort */ }
    }
    const tmp = `${cfgPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(merged.next, null, 2)}\n`);
    fs.renameSync(tmp, cfgPath);
    const st = gwsMcpStatus();
    let message = 'Added to Claude Desktop. Restart Claude Desktop to load it.';
    if (!st.desktopAppPresent) message = 'Config written. Claude Desktop is not installed on this Mac yet; it will pick this up once installed.';
    if (!st.gwsCliPresent) message += ' Note: the gws CLI is missing (npm i -g @googleworkspace/cli), calls will fail until it is installed (Settings > Google Accounts > Setup).';
    return { ok: true, message };
  } catch (e) {
    return { ok: false, message: `Could not set up Claude Desktop: ${e?.message || e}` };
  }
}

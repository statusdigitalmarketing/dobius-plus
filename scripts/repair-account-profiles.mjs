#!/usr/bin/env node
// Repair Claude account profiles so every account shares ONE setup.
//
// Why this exists as a script and not only as app startup code: v1.0.65
// shipped account switching that pointed each terminal at a per-account
// CLAUDE_CONFIG_DIR. Anyone who had ever clicked Switch got their entire
// session history orphaned, and `claude --resume <id>` answered "No
// conversation found" for every session the app listed. This repairs an
// affected machine WITHOUT waiting for the app update that does it on boot.
//
// Non-destructive by construction: it only ever creates symlinks and MOVES
// files into the shared store. It never deletes, and a name that exists on
// both sides is left alone.
//
//   node scripts/repair-account-profiles.mjs [--dry-run]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shareConfiguredProfiles, SHARED_ENTRIES } from '../electron/account-profile-share.js';

const dryRun = process.argv.includes('--dry-run');
const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'dobius-plus', 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Could not read ${configPath}: ${err.message}`);
  process.exit(1);
}

const accounts = (config.accounts || []).filter((a) => a?.type === 'claude' && a.claudeJsonPath);
if (accounts.length === 0) {
  console.log('No Claude account profiles configured. Terminals already use ~/.claude, nothing to repair.');
  process.exit(0);
}

const describe = (dir) => {
  const out = [];
  for (const name of SHARED_ENTRIES) {
    const p = path.join(dir, name);
    let st = null;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      let to = '(broken)';
      try { to = fs.realpathSync(p); } catch { /* dangling */ }
      out.push(`${name} -> ${to}`);
    } else if (st.isDirectory()) {
      let n = 0;
      try { n = fs.readdirSync(p).length; } catch { /* unreadable */ }
      out.push(`${name} (local dir, ${n} entries)`);
    } else {
      out.push(`${name} (local file)`);
    }
  }
  return out.length ? out.join('\n      ') : '(nothing yet)';
};

console.log(`Active account: ${config.activeClaudeAccountId || '(default ~/.claude)'}\n`);
for (const a of accounts) {
  console.log(`  ${a.name || a.id}\n      ${describe(path.dirname(a.claudeJsonPath))}`);
}

if (dryRun) {
  console.log('\n--dry-run: nothing changed.');
  process.exit(0);
}

console.log('\nLinking every profile to the shared ~/.claude setup...\n');
const results = shareConfiguredProfiles(accounts);

let problems = 0;
for (const r of results) {
  const statuses = Object.entries(r.report || {});
  const notable = statuses.filter(([, v]) => v !== 'already-shared' && v !== 'absent-in-default');
  console.log(`  ${path.basename(r.dir)}: ${notable.length ? notable.map(([k, v]) => `${k}=${v}`).join(' ') : 'already shared'}`);
  problems += statuses.filter(([, v]) => String(v).startsWith('error') || v === 'foreign-symlink' || v === 'kept-not-shared').length;
}

console.log('\nAfter:');
for (const a of accounts) {
  console.log(`  ${a.name || a.id}\n      ${describe(path.dirname(a.claudeJsonPath))}`);
}
console.log(problems === 0
  ? '\nDone. Open a NEW terminal tab; existing tabs keep the environment they were spawned with.'
  : `\nDone, with ${problems} entr${problems === 1 ? 'y' : 'ies'} left profile-local (see the warnings above).`);
